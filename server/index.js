const express = require('express');
const { OpenAI } = require('openai');
const ethers = require('ethers');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// OpenAI Configuration
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Perplexity API Configuration
const perplexityApiKey = process.env.PERPLEXITY_API_KEY;

// Ethereum Configuration
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contractABI = require('./contractABI.json');
const contractAddress = process.env.CONTRACT_ADDRESS;
const contract = new ethers.Contract(contractAddress, contractABI, wallet);
let currentNonce = null;

async function getPerplexityData(query) {
    try {
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: "llama-3.1-sonar-small-128k-online",
            messages: [
                { 
                    role: "system", 
                    content: "You are a highly knowledgeable assistant tasked with providing the most recent and relevant information on a given topic. Focus on factual, verifiable data from reliable sources. Include specific numbers, dates, and key events where applicable."
                },
                { 
                    role: "user", 
                    content: `Provide the most up-to-date and relevant information on the following topic: ${query}. Include recent developments, statistics, and expert opinions if available. Format the information in a clear, concise manner.`
                }
            ],
            max_tokens: 300,
            temperature: 0.5,
            top_p: 0.9,
            return_citations: true,
            search_domain_filter: ["perplexity.ai"],
            return_images: false,
            return_related_questions: false,
            search_recency_filter: "week",
        }, {
            headers: {
                'Authorization': `Bearer ${perplexityApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Error fetching data from Perplexity:", error);
        throw new Error("Failed to fetch data from Perplexity: " + error.message);
    }
}

async function generatePredictions(topic) {
    try {
        const perplexityData = await getPerplexityData(topic);
        
        const gpt4Prompt = `
Based on the following current information about ${topic}:

${perplexityData}

Generate 3 prediction market questions. Each prediction should be:
1. Specific and unambiguous
2. Measurable with a clear outcome
3. Have a definite timeframe for resolution (within the next 6 months)
4. Relevant to the given topic and current events
5. Interesting and engaging for participants

Output should be a valid JSON array of prediction objects with the following fields:
- description: The prediction question
- duration: Time until the prediction resolves, in seconds (max 6 months)
- tags: An array of relevant tags (3-5 tags)

Ensure the predictions are diverse and cover different aspects of the topic.
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "You are an expert in creating engaging and relevant prediction market questions based on current events and data."
                },
                { role: "user", content: gpt4Prompt }
            ],
            temperature: 0.7,
        });

        let predictions = JSON.parse(response.choices[0].message.content);
        return predictions.map(prediction => ({
            ...prediction,
            minVotes: 1,
            maxVotes: 1000,
            predictionType: 0,
            optionsCount: 2
        }));
    } catch (error) {
        console.error("Error generating predictions:", error);
        throw new Error("Failed to generate predictions: " + error.message);
    }
}

async function createPredictionOnContract(prediction) {
    try {
        console.log("Attempting to create prediction on contract:", prediction);
        console.log("Contract address:", contractAddress);
        console.log("Wallet address:", wallet.address);

        if (currentNonce === null) {
            currentNonce = await wallet.getTransactionCount();
        }

        console.log("Using nonce:", currentNonce);

        const tx = await contract.createPrediction(
            prediction.description,
            prediction.duration,
            prediction.minVotes,
            prediction.maxVotes,
            prediction.predictionType,
            prediction.optionsCount,
            prediction.tags,
            { nonce: currentNonce }
        );

        console.log("Transaction sent:", tx.hash);
        currentNonce++;
        
        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt.blockNumber);
        return tx.hash;
    } catch (error) {
        console.error("Detailed error in createPredictionOnContract:", error);
        
        if (error.message.includes("nonce too low")) {
            console.log("Nonce too low, resetting...");
            currentNonce = null;
        }
        
        throw new Error(`Failed to create prediction on contract: ${error.message}`);
    }
}

app.post("/generate-predictions", async (req, res) => {
    try {
        console.log("Received request to generate predictions");
        const { topic } = req.body;
        if (!topic) {
            return res.status(400).json({ error: "Topic is required" });
        }

        console.log("Generating predictions for topic:", topic);
        const predictions = await generatePredictions(topic);
        console.log("Generated predictions:", predictions);

        const createdPredictions = [];
        for (const prediction of predictions) {
            try {
                console.log("Creating prediction on contract:", prediction);
                const txHash = await createPredictionOnContract(prediction);
                console.log("Prediction created with transaction hash:", txHash);
                createdPredictions.push({ ...prediction, transactionHash: txHash });
            } catch (error) {
                console.error("Error creating prediction:", error);
                createdPredictions.push({ ...prediction, error: error.message });
            }
        }

        res.json({ predictions: createdPredictions });
    } catch (error) {
        console.error("Error in generate-predictions endpoint:", error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

app.post("/finalize-prediction/:id", async (req, res) => {
    try {
        const predictionId = req.params.id;
        const prediction = await contract.getPredictionDetails(predictionId);
        const [description] = prediction;

        console.log(`Finalizing prediction ${predictionId}: ${description}`);

        const currentData = await getPerplexityData(description);
        const outcome = await determineOutcome(description, currentData);

        console.log(`Determined outcome for prediction ${predictionId}:`, outcome);

        const tx = await contract.finalizePrediction(predictionId, outcome);
        await tx.wait();

        console.log(`Finalized prediction ${predictionId} with transaction hash:`, tx.hash);

        res.json({ 
            message: `Prediction ${predictionId} finalized successfully`,
            outcome: outcome,
            transactionHash: tx.hash
        });
    } catch (error) {
        console.error("Error in finalize-prediction endpoint:", error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

async function determineOutcome(description, currentData) {
    try {
        const prompt = `
Analyze the following prediction and the most recent related information to determine its outcome:

Prediction: "${description}"

Current Information:
${currentData}

Based on this data, has the prediction come true? Respond with:
- 0 if the prediction is false or has not occurred
- 1 if the prediction is true or has occurred

If the information is insufficient to make a definitive determination, lean towards 0 (false).

Provide your reasoning, then on a new line, give ONLY the numeric outcome (0 or 1).
`;
        
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { 
                    role: "system", 
                    content: "You are an impartial judge tasked with determining the outcomes of prediction markets based on the most current and relevant information available."
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.1,
        });

        const fullResponse = response.choices[0].message.content.trim();
        const lines = fullResponse.split('\n');
        const outcome = parseInt(lines[lines.length - 1]);
        
        if (isNaN(outcome) || (outcome !== 0 && outcome !== 1)) {
            throw new Error("Invalid outcome determined by AI");
        }

        return outcome;
    } catch (error) {
        console.error("Error determining outcome:", error);
        throw new Error("Failed to determine outcome: " + error.message);
    }
}

app.get("/prediction/:id", async (req, res) => {
    try {
        const predictionId = req.params.id;
        const prediction = await contract.getPredictionDetails(predictionId);
        res.json(prediction);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.post("/test/generate-predictions", async (req, res) => {
    try {
        console.log("Received request to generate test predictions");
        const { topic } = req.body;
        if (!topic) {
            return res.status(400).json({ error: "Topic is required" });
        }

        console.log("Generating test predictions for topic:", topic);
        const predictions = await generatePredictions(topic);
        console.log("Generated test predictions:", predictions);

        res.json({ predictions: predictions });
    } catch (error) {
        console.error("Error in test generate-predictions endpoint:", error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// New testing endpoint for finalizing predictions without blockchain interaction
app.post("/test/finalize-prediction", async (req, res) => {
    try {
        const { description } = req.body;
        if (!description) {
            return res.status(400).json({ error: "Prediction description is required" });
        }

        console.log(`Test finalizing prediction: ${description}`);

        const currentData = await getPerplexityData(description);
        const outcome = await determineOutcome(description, currentData);

        console.log(`Test determined outcome for prediction:`, outcome);

        res.json({ 
            message: `Test prediction finalized successfully`,
            description: description,
            outcome: outcome,
            currentData: currentData
        });
    } catch (error) {
        console.error("Error in test finalize-prediction endpoint:", error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});


app.get("/user-stats/:address", async (req, res) => {
    try {
        const userAddress = req.params.address;
        const stats = await contract.getUserStats(userAddress);
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});