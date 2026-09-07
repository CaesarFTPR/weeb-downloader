#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HOST_SCRIPT="$DIR/kindle_transfer_host.py"
MANIFEST_FILE="$DIR/com.weebdownloader.kindle.json"
DEFAULT_EXT_ID="kipgkfhcagnbofkaiechcpfgfmcdeald"

# If user provided custom extension ID as argument, use it
EXT_ID="${1:-$DEFAULT_EXT_ID}"

echo "=========================================================="
echo " Installing Kindle Native Messaging Host for Chrome"
echo " Extension ID: $EXT_ID"
echo " Host script:  $HOST_SCRIPT"
echo "=========================================================="

# Ensure host script is executable
chmod +x "$HOST_SCRIPT"

# Target directory for Chrome native messaging manifests on macOS
CHROME_TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
BRAVE_TARGET_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
EDGE_TARGET_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"

mkdir -p "$CHROME_TARGET_DIR"

# Generate manifest JSON with absolute path and extension ID
TMP_MANIFEST=$(mktemp)
cat <<EOF > "$TMP_MANIFEST"
{
  "name": "com.weebdownloader.kindle",
  "description": "Kindle SSH SCP Native Messaging Host for WeebCentral Downloader",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

# Install to Google Chrome
cp "$TMP_MANIFEST" "$CHROME_TARGET_DIR/com.weebdownloader.kindle.json"
echo " Installed to Google Chrome: $CHROME_TARGET_DIR/com.weebdownloader.kindle.json"

# Install to Brave if directory exists
if [ -d "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" ]; then
    mkdir -p "$BRAVE_TARGET_DIR"
    cp "$TMP_MANIFEST" "$BRAVE_TARGET_DIR/com.weebdownloader.kindle.json"
    echo " Installed to Brave: $BRAVE_TARGET_DIR/com.weebdownloader.kindle.json"
fi

# Install to Edge if directory exists
if [ -d "$HOME/Library/Application Support/Microsoft Edge" ]; then
    mkdir -p "$EDGE_TARGET_DIR"
    cp "$TMP_MANIFEST" "$EDGE_TARGET_DIR/com.weebdownloader.kindle.json"
    echo " Installed to Microsoft Edge: $EDGE_TARGET_DIR/com.weebdownloader.kindle.json"
fi

rm -f "$TMP_MANIFEST"

echo ""
echo " Installation complete!"
echo "You can now test the connection and transfer manga to Kindle directly from the extension."
