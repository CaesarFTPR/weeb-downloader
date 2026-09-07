# 📖 WeebCentral Kindle Downloader & Sync

[![Chrome Extension](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![KOReader](https://img.shields.io/badge/KOReader-Compatible-FF6B6B?logo=read-the-docs&logoColor=white)](https://koreader.rocks/)
[![Python 3](https://img.shields.io/badge/Python-3.9+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![LuaJIT](https://img.shields.io/badge/Device%20Engine-LuaJIT%202.1-000080?logo=lua&logoColor=white)](https://luajit.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**WeebCentral Kindle Downloader** is an open-source Google Chrome / Chromium extension designed to download manga chapters from [WeebCentral](https://weebcentral.com) in native **KOReader formats** (`.cbz`, `.zip`, raw folders), apply **hardware-accelerated E-Ink image optimizations**, and instantly sync chapters to your **Kindle** over Wi-Fi via SSH/SCP.

Featuring **True In-Place Binary ZIP Appending (v3.0.0)**, new chapters are merged into your cumulative manga volume on the Kindle in **0.12 seconds** without re-writing existing chapters!

---

## ✨ Features

### 📚 1. Single Book on the Shelf (Cumulative Volumes)
* **Clean Library**: Instead of cluttering your reader with dozens of loose chapter archives, your manga is organized as a single clean volume: `{title}.cbz` (e.g. `Chainsaw Man.cbz`).
* **Cover & Metadata**: Automatically embeds official high-resolution cover art, `ComicInfo.xml` (ComicRack/Calibre compatible), and Table of Contents (`toc.ncx`).
* **Continuous Reading**: Turn pages seamlessly from Chapter 1 to Chapter 100 without returning to the file manager.

### ⚡ 2. True In-Place Binary ZIP Appending (v3.0.0)
* **$O(\Delta)$ Complexity**: Adding a new 2 MB chapter to a 500 MB manga volume takes **0.12 seconds**!
* **Zero Flash Wear**: Unlike naive zip mergers that re-read and re-write every image in the book, our native LuaJIT engine seeks directly to the Central Directory offset, writes *only* the new chapter bytes, and updates the index.
* **No Disk Bloat**: Zero temporary files created on Kindle storage.

### 📱 3. Direct Wi-Fi Transfer to Kindle (SSH / SCP)
* **One-Click Sync**: Send new chapters directly from your browser to your Kindle over local Wi-Fi.
* **Auto-Transfer**: Option to automatically transfer chapters as soon as the download completes.
* **Zero Cloud Dependencies**: Direct local network transfer between your PC and Kindle via Chrome Native Messaging.
* **Smart Connection**: Auto-fallback to `kindle.local` (mDNS) if your router assigns a new local IP.

### 📖 4. Live KOReader Reading Progress Sync
* **Real-time Status**: Reads KOReader's `.sdr/metadata.cbz.lua` on the device and displays your exact reading progress in the extension header (e.g. `📖 Kindle: 45% (Ch. 128)`).
* **Reading Marker**: Highlights the chapter you are currently reading with a distinct badge in the chapter list.

### 🎨 5. E-Ink Visual Optimizer
* **Contrast & White Balancing**: Strips dirty scan backgrounds and levels paper whites for crisp e-paper contrast.
* **Micro-Sharpening**: Custom convolution kernel tuned for 300 PPI E-Ink displays.
* **Hardware Accelerated**: Fast client-side image processing via HTML5 Canvas and Web Workers.
* **Size Reduction**: Converts bulky 2500px scans to device-native resolution (e.g. 1680px for Paperwhite/Oasis/Scribe) with WebP/JPEG quantization, cutting file sizes by 40–60%.

### 🔍 6. Archive Scanner & Chapter Management
* **Dual-Target Status**: Visual badges show where each chapter is stored: `PC + Kindle`, `PC`, or `Kindle`.
* **Quick Filters**: Instantly hide already-downloaded chapters (`Hide Done`) or search by chapter number/title.
* **Bulk Selection**: Flexible range selection (e.g. `1-10, 15, 20-25`), invert, or select all.

---

## ⚡ Performance: Traditional Re-pack vs In-Place Append

Tested on physical **Kindle Paperwhite (ARMv7)** with a 190 MB volume (25 chapters, 539 pages):

| Metric | Traditional Zip Rewrite | True In-Place Append (v3.0.0) | Improvement |
| :--- | :--- | :--- | :--- |
| **Append Time** | 45 – 60 seconds | **0.12 seconds (120 ms)** | **⚡ 400x – 500x faster** |
| **Storage Write I/O** | 190 MB rewrite + temp copy | **~2 MB (only the new chapter)** | **99% less flash wear** |
| **Scaling** | Degrades with book size $O(N)$ | **Depends only on new chapter $O(\Delta)$** | **Constant speed** |
| **Shelf Integrity** | Single `.cbz` book | **Single `.cbz` book** | Preserved |
| **Reading Statistics** | Maintained | **Maintained (`metadata.cbz.lua`)** | Preserved |

---

## 📦 Installation Guide

### Prerequisites
- Google Chrome, Brave, Edge, Arc, or any Chromium-based browser.
- Python 3.9+ (preinstalled on macOS/Linux; available for Windows).
- A jailbroken Kindle with **KOReader** installed and **SSH Server** enabled.

---

### Step 1: Install the Chrome Extension
1. Clone or download this repository to your computer:
   ```bash
   git clone https://github.com/CaesarFTPR/weeb-downloader.git
   cd weeb-downloader
   ```
2. Open your browser and navigate to `chrome://extensions/`.
3. Toggle on **Developer mode** in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the `weeb-downloader` folder.
6. The extension icon will appear in your toolbar. Pin it for quick access!

---

### Step 2: Install Native Messaging Host (for SSH/SCP)
The Native Messaging Host is a lightweight Python bridge that enables the extension to communicate with your Kindle via SSH/SCP and perform fast in-place archive merges.

#### On macOS & Linux:
Run the installer script from terminal:
```bash
./native_host/install.sh
```
*The installer automatically detects Chrome, Brave, and Edge directories and registers the native manifest.*

#### On Windows:
1. Open PowerShell and run:
   ```powershell
   python native_host\kindle_transfer_host.py --register
   ```
   *(Or add the registry key under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.weebdownloader.kindle` pointing to `com.weebdownloader.kindle.json`).*

---

### Step 3: Setup KOReader on Kindle
1. Open **KOReader** on your Kindle.
2. Tap the top menu $\to$ **Tools (wrench icon)** $\to$ **SSH server**.
3. Turn on **Start SSH server**.
   - Note the connection information shown (usually port `2222`, user `root`).
4. *(Recommended)* Configure passwordless login or copy your SSH public key to Kindle:
   ```bash
   ssh-copy-id -p 2222 root@kindle.local
   # or: ssh-copy-id -p 2222 root@<KINDLE_IP>
   ```

---

## 🚀 How to Use

1. **Browse**: Open any manga series page on [WeebCentral](https://weebcentral.com), for example:
   ```
   https://weebcentral.com/series/01J76XYBPKS1TM2S3AWVSNBH3X/Kaguya-Wants-To-Be-Confessed-To
   ```
2. **Select Chapters**:
   - Click the extension icon.
   - Enter a range in the box (e.g. `1-10`) and click **Select**, or check chapters manually.
3. **Download**:
   - Click **📥 Download Selected**.
   - The extension downloads pages, applies E-Ink optimizations, and packs chapters into your target volume.
4. **Sync to Kindle**:
   - Click **📱 Send to Kindle** to transfer over Wi-Fi, or enable **Auto-send to Kindle** in Settings to do it automatically!
5. **Read**:
   - Open KOReader on your Kindle. Your manga appears right on your bookshelf with its cover. Tap to read!

---

## ⚙️ Settings Reference

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Packaging Mode** | Cumulative Tome (`.cbz`) | Recommended. All chapters merged into one seamless book. |
| **Target Subfolder** | `{title}` | Folder on PC where manga volumes are stored. |
| **Local Downloads** | `~/Downloads` | Base download folder on your computer. |
| **Kindle IP / Host** | `kindle.local` | Kindle IP address or mDNS hostname. |
| **SSH Port** | `2222` | Default KOReader SSH server port. |
| **SSH User** | `root` | Default Kindle SSH user. |
| **SSH Password** | *(blank)* | Optional root password (leave empty if login without password is enabled). |
| **SSH Key Path** | *(optional)* | Path to private SSH key (e.g. `~/.ssh/id_ed25519`). |
| **Remote Kindle Path**| `/mnt/us/koreader/` | Destination directory on Kindle storage. |
| **Optimize for E-Ink**| Enabled | Applies grayscale conversion, white balance, and contrast leveling. |
| **Max Resolution** | `1680` px | Scales images to match Kindle screen dimensions. |
| **Image Quality** | `0.75` | WebP/JPEG quality balance. |
| **Auto-send to Kindle**| Disabled | Automatically triggers Wi-Fi transfer upon download completion. |

---

## 🛠️ Project Structure

```
weeb-downloader/
├── manifest.json              # Chrome Extension Manifest V3
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.js               # UI interaction and chapter management
│   └── popup.css              # Dark theme stylesheet
├── background/
│   └── service_worker.js      # Background downloader, queue & E-Ink optimizer
├── content/
│   └── content.js             # Page metadata & chapter list parser
├── native_host/
│   ├── kindle_transfer_host.py# Python Native Messaging Host (SSH/SCP bridge)
│   ├── merge_volume.lua       # True In-Place binary ZIP append engine (LuaJIT)
│   ├── install.sh             # Native host installer for macOS / Linux
│   └── com.weebdownloader.kindle.json # Host manifest template
├── icons/                     # Application icons (16, 48, 128)
├── LICENSE                    # MIT License
└── README.md                  # Documentation
```

---

## 🤝 Contributing

Contributions, bug reports, and feature requests are very welcome!
Feel free to open an issue or submit a pull request.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
Manga content and trademarks belong to their respective copyright holders and publishers.
