# Token Rotation Setup

This document describes the operational procedure to initialize the multi-account token registry for Heimdall.

## Overview
Heimdall supports multiple Claude API accounts to facilitate token rotation when a usage cap is reached. The configuration involves securely storing the primary and secondary account tokens in a local JSON registry that Heimdall can read at runtime.

## Requirements
- Primary Claude API token
- Secondary Claude API token
- Operator access to the system running Heimdall

## Initialization Procedure
1. Obtain the required Claude API tokens.
2. Run the token registry setup script:
   ```bash
   ./scripts/setup-token-registry.sh
   ```
3. When prompted, enter the primary and secondary account tokens. The script will securely create and initialize the configuration.

## Security Considerations
- **Storage**: Tokens are stored locally on the filesystem at `~/.heimdall/token-registry.json`.
- **Permissions**: The setup script explicitly restricts file permissions to `600` (read/write by owner only) to prevent unauthorized access by other users on a shared system.
- **Input**: The tokens are prompted for interactively (`read -s`), which ensures they are not exposed in bash history or command-line arguments.

## Verification
To verify the setup:
- Inspect the file permissions:
  ```bash
  ls -l ~/.heimdall/token-registry.json
  ```
  Expected output should look like `-rw------- ...`
- Ensure the JSON content structure aligns with the Heimdall token registry schema.
- Perform a manual cap simulation (if implemented in the rotation controller) to test the rotation behavior.
