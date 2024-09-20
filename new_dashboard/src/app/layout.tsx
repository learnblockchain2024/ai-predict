import React, { ReactNode } from 'react';
import AppWrappers from './AppWrappers';
// import '@asseinfo/react-kanban/dist/styles.css';
// import '/public/styles/Plugins.css';
import { DynamicContextProvider, DynamicWidget } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body id={'root'}>
        <AppWrappers>
        <DynamicContextProvider
    settings={{
      environmentId: '8d1a0fcf-94bc-4ca7-bbe0-0d36017f8084',
      walletConnectors: [ EthereumWalletConnectors ],
    }}>{children}
    
    </DynamicContextProvider>
    </AppWrappers>
      </body>
    </html>
  );
}
