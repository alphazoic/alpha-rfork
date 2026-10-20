# M3 (Mega Manager Max) — Comprehensive Documentation & VPN Guide

The **Inbox** tab combines catch-all mail across multiple domains and Cloudflare
mail connections. Add domains in bulk, filter the combined inbox by domain, and
confirm each domain with a delivery test. See [setup and inbox limits](docs/cloudflare-inbox.md), or use
**Inbox → Manage domains → Export Worker setup** for the deployable files.

M3 is a high-performance desktop application for Linux and Windows built with Electron, Node.js, and specialized native tools (`megatools`, `MEGAcmd`, `rfork`, `7-Zip`, and `MediaInfo`). It automates and optimizes downloading, streaming, uploading, account lifecycle management, bulk importing, and forum post templating for [MEGA.nz](https://mega.nz).

This document provides a comprehensive operational guide to the program, covering core transfer engines, settings, and its zero-leak, operation-gated **Proton VPN** subsystem.

---

## Table of Contents

1. [System Overview & Architecture](#system-overview--architecture)
2. [Core Program Features](#core-program-features)
   - [Downloads & Stream Mode](#downloads--stream-mode)
   - [Uploads & Multi-Tool Engine](#uploads--multi-tool-engine)
   - [Account Management & Strategy](#account-management--strategy)
   - [Bulk Import & Remote Folder Browsing](#bulk-import--remote-folder-browsing)
   - [MediaInfo Checker & Post Templates](#mediainfo-checker--post-templates)
3. [Proton VPN Integration: How It Works](#proton-vpn-integration-how-it-works)
   - [Architecture & Operation Leases](#architecture--operation-leases)
   - [Zero-Leak Guarantee & CLI Verification](#zero-leak-guarantee--cli-verification)
   - [Local Server Catalog & Selection Engine](#local-server-catalog--selection-engine)
   - [Resilient Connection Retry Engine](#resilient-connection-retry-engine)
   - [Workflow Recovery Integrations](#workflow-recovery-integrations)
4. [Customization & Options Reference](#customization--options-reference)
   - [Proton VPN Settings](#proton-vpn-settings)
   - [Network & Proxy Settings](#network--proxy-settings)
   - [Folder & Storage Locations](#folder--storage-locations)
   - [Download Engine Options](#download-engine-options)
   - [Upload Engine Options (Megatools & MEGAcmd)](#upload-engine-options-megatools--megacmd)
   - [Tool Priority & Fallback Chains](#tool-priority--fallback-chains)
   - [Templates & Integrations (OMDB & BBCode)](#templates--integrations-omdb--bbcode)
   - [Appearance, Fonts & Layout](#appearance-fonts--layout)
5. [Best Practices & Pro Tips](#best-practices--pro-tips)
6. [Troubleshooting & FAQ](#troubleshooting--faq)

---

## System Overview & Architecture

M3 bridges high-level Electron UI controls with low-level CLI binaries and custom networking pipelines:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        M3 Renderer UI (Electron)                       │
│  [Download Tab]   [Upload & Bulk Import Tab]   [Settings & Proton VPN] │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ IPC (Preload Allowlist)
┌───────────────────────────────────▼────────────────────────────────────┐
│                       Main Process Coordinator                         │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                 Network Operations Manager                     │   │
│   │       (Operation Leases, Mutexes, megacmd-session lock)        │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │                                    │
│   ┌───────────────────────────────▼────────────────────────────────┐   │
│   │                     Shared VPN Controller                      │   │
│   │  - State Machine (Connecting, Connected, Waiting, Attention)   │   │
│   │  - Offline Catalog Selector (16,821 servers across 144 countries)│ │
│   │  - Candidate-Round Retry Engine & Speed Budget Watchdog        │   │
│   │  - Official Linux Proton VPN CLI Adapter                       │   │
│   └────────────────────────────────────────────────────────────────┘   │
└──────────────┬────────────────────────┬───────────────────┬────────────┘
               │                        │                   │
    ┌──────────▼──────────┐  ┌──────────▼────────┐  ┌───────▼────────────┐
    │   Download Engine   │  │   Upload Engine   │  │  Account Manager   │
    │ - Worker GET Proxy  │  │ - megatools fork  │  │ - Temp-Mail / Auto │
    │ - Chunk Pipelines   │  │ - MEGAcmd daemon  │  │ - Login Refresh    │
    │ - CBC-MAC Checksum  │  │ - rfork / 7-Zip   │  │ - Quota Tracking   │
    │ - Stream HTTP/Sparse│  │ - Boundary Switch │  │ - Multi-Account CSV│
    └─────────────────────┘  └───────────────────┘  └────────────────────┘
```

- **Isolated Background Pipelines:** Heavy network I/O, subprocess spawns, and integrity verifications run in background Node.js runtimes without freezing the UI.
- **Atomic Operations & Safe Boundaries:** Uploads, downloads, and account refreshes operate with transactional boundaries. If a connection drops, data is preserved rather than corrupted or discarded.
- **Native CLI Management:** Bundles custom builds of `megatools`, `rfork`, `mediainfo`, and `7z` in `bin/<platform>/`, using system-installed `megacmd` and `protonvpn` CLI on Linux.

---

## Core Program Features

### Downloads & Stream Mode

M3 is engineered for maximum throughput and reliability when downloading from MEGA:

- **Cloudflare Workers Proxy:** Seamlessly bypasses MEGA's bandwidth quotas (IP-based download limits) by routing file chunk requests through a user-supplied Cloudflare Worker proxy.
- **Large-File Chunking:** Large files are split into manageable chunk sizes (512 MB, 1 GB, 2 GB, or 4 GB). Each chunk downloads with atomic resume checkpoints. If interrupted, only uncompleted chunks are re-requested.
- **True RFC 9110 Range & CBC-MAC Verification:** Resumed downloads use HTTP 206 `Content-Range` chunk verification. Before files are finalized, M3 validates the data using an internal implementation of MEGA’s proprietary CBC-MAC algorithm (`src/mega-mac.js`), preventing corrupted or truncated files.
- **Stream Mode (Watch While Downloading):**
  - Downloads the file header (metadata) and tail (index/trailer) first, followed by sequential body chunks.
  - **Local HTTP Proxy:** Serves the growing file over a local loopback server (`http://127.0.0.1:<port>`), allowing players like VLC or MPV to seek instantly.
  - **Sparse File (Linux Only):** Allocates the full file with filesystem holes, writing chunks as they arrive.
  - **Auto-Launch:** Automatically launches your default video player the moment buffering reaches a playable threshold.

### Uploads & Multi-Tool Engine

Uploads support multiple backend CLI tools with configurable fallback priority:

- **Supported Tools:**
  1. **megatools (bundled custom fork):** High-speed multithreaded uploads with **Boost Mode** (bundles micro-buffers into large chunk streams per worker).
  2. **MEGAcmd (official daemon):** Robust official client capable of high-connection parallelism.
  3. **rfork:** Fork of rclone 1.75.2 with concurrent native MEGA chunk uploads, HTTPS by default, and structured JSON progress streams.
  4. **Browser Upload (Puppeteer):** Automated browser fallback when CLI methods are blocked.
- **rfork upload settings:** Configure workers, HTTPS, request bundling, pacing, retries, buffering, transport limits and restart checkpoints. See the [settings guide](docs/rfork-settings.md) and [current validation status](docs/rfork-settings-validation.md).
- **Interrupted rfork uploads:** M3 holds uncertain remote results for inspection before another upload is allowed. Local sources and unfinished archive parts are retained; a failed share-link lookup does not repeat an already committed upload.
- **rfork package validation:** Packaged M3 uploads, independent download hashes, account consumers and Stop/restart safeguards passed on Linux x64, Windows x64 and Intel macOS. See the [current validation report](docs/rfork-settings-validation.md) for the configurable uploader and checkpoint recovery; the [earlier alpha report](docs/rfork-package-validation.md) preserves its original artifacts and receipts.
- **7-Zip Auto-Archiving & Splitting:** Files exceeding your configured threshold (e.g., 20 GB) are automatically packed and split into multi-part 7z archives with custom part naming before upload.
- **Smart Ordering:** Automatically prioritizes small files or archive parts to maximize storage efficiency before launching long uploads.
- **Account Strategy:** Automatically resumes the last active account, switches to a new account upon hitting storage quotas, or registers fresh accounts automatically.

### Account Management & Strategy

- **Automated Lifecycle:** Creates accounts using the signup email source selected in Settings: existing temporary-mail services or enabled Cloudflare inbox domains. Cloudflare domains rotate through a shuffled deck saved across restarts, and confirmation runs in the background. Passwords, initial logins, and security key generation follow the existing workflow.
- **Account Refresh & Dormancy Checker:** Probes saved accounts to update used storage, verify validity, and flag dormant or suspended accounts without terminating active sessions.
- **Safe CSV Persistence:** Account states, credentials, quotas, and upload history are persisted to atomic CSV logs (`account_log.csv`, `upload_log.csv`).

### Bulk Import & Remote Folder Browsing

- **Direct Cloud Ingestion:** Import public MEGA files or entire directory trees directly into your managed MEGA accounts without downloading them to your local disk.
- **Folder Browser Modal:** Paste any public MEGA folder link to fetch its directory tree, filter by keyword or extension, select specific files, and queue them for download or import.

### MediaInfo Checker & Post Templates

- **Remote MediaInfo Extraction:** Reads video/audio headers directly from remote MEGA links using partial HTTP range reads without downloading the complete video.
- **OMDB API Integration:** Fetches movie/TV metadata (title, year, plot, genre, actors, poster) via OMDB API keys.
- **Templating Engine:** Formats generated links and MediaInfo into customizable BBCode or Markdown for forum or blog posting. Supports variables like `{{File Name}}`, `{{File Size}}`, `{{Links Block}}`, and `{{OMDB Plot}}`.

---

## Proton VPN Integration: How It Works

The Proton VPN integration in M3 provides seamless, automated VPN control specifically designed for heavy data transfers and account operations on Linux.

### Architecture & Operation Leases

M3 coordinates all network activity through a central **VPN Controller** (`src/vpn-controller.js`) and **Network Operations Coordinator** (`src/network-operations.js`).

1. **Operation Leases:** Whenever an upload, download, account refresh, or folder scrape begins, it acquires an operation lease.
2. **Exclusive Session Locks:** Tasks requiring account authentication acquire the exclusive `megacmd-session` resource lock. This ensures no background process logs out or rotates accounts while another process is actively transferring files.
3. **Connection Barriers:** When a VPN switch is requested (manually, via account rotation, or via speed recovery), the controller holds the switch behind a **barrier** until active file commits, HTTP requests, or subprocesses release their leases. Work is never abruptly dropped mid-transfer.

### Zero-Leak Guarantee & CLI Verification

- **Pure Local Verification:** M3 relies strictly on the official Linux `protonvpn` CLI status.
- **No Third-Party Leakage:** M3 **does not** query external IP websites (e.g., `icanhazip.com` or `ipinfo.io`) or perform HTTP ping checks to test VPN status. Everything is verified locally via CLI execution.
- **Safe Process Termination:** Subprocesses are terminated gracefully with `SIGTERM`, escalating to `SIGKILL` if necessary. If process termination cannot be confirmed, M3 locks further VPN commands to prevent undefined network states.
- **Protection Policy:**
  - **Manual Control (Default):** Direct connectivity is permitted while disconnected. When connected, all traffic routes through Proton VPN. If an automated switch fails or status is ambiguous, work is paused/held rather than silently falling back to an unencrypted direct connection.
  - **VPN-Required Mode:** Locked until OS packet-level leak protection (kill switch) verification is supplied.

### Local Server Catalog & Selection Engine

Rather than relying on real-time network queries, M3 uses an offline catalog of Proton VPN servers:

- **Bundled Superlist (`assets/proton-vpn-servers.csv`):** Contains **16,821 regular servers** across **144 countries** and **189 country/city locations**. Tor-exit nodes are automatically identified and excluded.
- **Custom Catalog Import:** Users can import their own server CSV files (`country,city,server`) through the native file picker.
- **Smart Filtering:** Select by entire countries, specific cities, or exact server IDs. Exclusions always override inclusions.
- **Intelligent Rotation Algorithms:**
  - **Country-Balanced Shuffle (Default):** Shuffles servers within each country and picks round-robin across nations. This ensures large server farms (e.g., US or NL) do not overwhelm small pools.
  - **Shuffle Without Repeats:** Pure random shuffle across the pool with no repeats in a single cycle.
  - **File Order:** Strict sequential order as defined in the catalog file.
- **Avoidance Memory:**
  - The **current server** is always automatically excluded during rotation.
  - Configurable **recent-server memory** avoids the last *N* servers (default 5).

### Resilient Connection Retry Engine

When connecting to servers or recovering from slow transfers, M3 runs a bounded candidate-round engine (`src/vpn-retry.js`):

```
[Trigger: Manual / Rotation / Recovery]
                   │
                   ▼
       [Acquire Switch Barrier]
                   │
                   ▼
       [Query Proton CLI Status]
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
 [Disconnected]          [Current Server Identified]
       │                       │ (Add to Exclusion)
       └───────────┬───────────┘
                   │
                   ▼
       [Select Eligible Candidate from Pool]
       (Excludes current, recent N, & cooldown servers)
                   │
                   ▼
     [Execute CLI: protonvpn c --server ID]
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
   [Success]               [Failure]
       │                       │
 [Verify Status]         [Inspect Safe Error]
       │                       │
       │           ┌───────────┴───────────┐
       │           ▼                       ▼
       │     [Network/Timeout]       [Auth/Plan/Keyring]
       │           │                       │
       │     [Mark Cooldown]               ▼
       │     [Exponential Backoff]   [Attention State]
       │           │                 (Holds for User)
       │           ▼
       │     [Next Candidate]
       │     (Up to Max Candidates)
       │           │
       │           ▼
       │     [Round Exhaustion]
       │     (Waiting State: Timer / Edit Pool)
       │
       ▼
 [Release Barrier & Resume Operations]
```

- **Candidate Cycling:** If a server fails to connect, M3 records the failure, places the server on a temporary cooldown (default 15 minutes), applies exponential backoff, and tests the next candidate.
- **Round Exhaustion & Pausing:** If an entire round (e.g., 10 candidates) fails, M3 does not crash or kill your transfers. It enters a `Waiting to retry` state with an automatic countdown timer.
- **Dynamic Pool Editing:** While in the `Waiting` state, you can click **Edit waiting pool**, modify your country or server selections, and click **Apply pool and retry** to immediately test a new pool without aborting your queued downloads or account batches.

### Workflow Recovery Integrations

1. **Account Refresh Rotation:**
   - Automatically switches servers **Every account** or **Every N accounts**.
   - Completed results are committed to CSV immediately.
   - If a VPN switch fails during account refresh, the account is **never** flagged as dead, terminated, or invalid; the batch waits safely for connectivity.
2. **Download Speed Recovery:**
   - Continuously monitors raw byte delivery on active Worker download connections.
   - If transfer speed falls below a minimum threshold (e.g., 2.0 MB/s) for a sustained period (e.g., 90s) after warmup, M3 initiates recovery.
   - Active streams safely drain and close, the controller switches to a fresh server, and downloads resume using retained chunks.
   - Video streaming automatically defers recovery while playback data is actively advancing.
3. **Upload Speed Recovery (Safe File Boundaries):**
   - Upload CLI tools cannot safely pause mid-chunk without risking file duplication or corruption.
   - Therefore, M3 implements **Boundary Recovery**: if an upload drops below threshold, M3 flags the condition, allows the current file to complete, logs its CSV link, and switches VPN servers *between* files on the same account.
4. **Reconnect After Tunnel Loss:**
   - If the system VPN disconnects unexpectedly, active network requests are cleanly interrupted.
   - Downloads preserve cached chunks and resume automatically once the tunnel is re-established.
   - Uploads safely halt and prompt for a remote-file verification before resuming to avoid partial files.

---

## Customization & Options Reference

### Proton VPN Settings

Located in **Settings → Proton VPN** (Linux only):

| Setting | UI Element | Default | Description |
| :--- | :--- | :--- | :--- |
| **App Control** | Checkbox (`vpn-enabled`) | `Disabled` | Enables M3 control over the installed `protonvpn` CLI. |
| **Connection Policy** | Dropdown (`vpn-mode`) | `Manual control` | `Manual control` allows direct connections when VPN is off. `VPN-required` enforces 100% encrypted traffic (requires OS leak protection). |
| **Catalog Source** | Buttons | Bundled | Switch between the bundled 16,821-server list, custom imported CSV, or reset. |
| **Include Mode** | Dropdown (`vpn-pool-mode`) | `All regular servers` | Choose from `All regular servers`, `Selected countries`, `Selected cities`, `Exact server IDs`, or `Mixed`. |
| **Countries Filter** | Textarea / Picker | Empty | Comma- or newline-separated country names or two-letter country codes (e.g., `Germany, CA, Netherlands`). |
| **Cities Filter** | Multi-select (`vpn-cities`) | Empty | Filter by specific country/city pairs. Supports Ctrl/Shift multi-select. |
| **Server IDs Filter** | Textarea (`vpn-servers`) | Empty | Explicit Proton server IDs (e.g., `CH#242, DE#12, US-FREE#12`). |
| **Exclusions** | Collapsible Section | Empty | Exclude specific countries, cities, or server IDs. Strictly overrides inclusions. |
| **Server Ordering** | Dropdown (`vpn-order`) | `Country-balanced` | `Country-balanced shuffle`, `Shuffle without repeats`, or `Order in the file`. |
| **Avoid Last N Servers** | Number (`vpn-recent`) | `5` | Number of recently connected servers to avoid during rotation (0–1000). |
| **Broader Fallback** | Checkbox (`vpn-fallback`) | `Disabled` | When enabled, falls back to other regular catalog servers if the selected pool is exhausted. |
| **Attempts Per Server** | Number (`vpn-retry-attempts`) | `1` | Connection attempts per candidate before moving to the next server (1–10). |
| **Servers Per Round** | Number (`vpn-retry-candidates`)| `10` | Maximum candidate servers tested in a single retry round (1–1,000). |
| **Command Deadline** | Number (`vpn-retry-process`) | `90 s` | M3 process guard timeout for CLI commands. |
| **Round Budget** | Number (`vpn-retry-round`) | `300 s (5 min)`| Maximum time allowed for an entire candidate round. |
| **Initial Retry Delay** | Number (`vpn-retry-initial`) | `1.5 s` | Backoff delay before the second candidate attempt. |
| **Maximum Retry Delay** | Number (`vpn-retry-max`) | `10.0 s` | Maximum capped backoff delay between candidates. |
| **Failed Server Cooldown**| Number (`vpn-retry-cooldown`)| `15 min` | Period during which failed servers are skipped in subsequent rounds. |
| **Between Rounds Delay** | Number (`vpn-retry-restart`) | `30 s` | Suggested wait time before launching a new round after exhaustion. |
| **Reconnect on Tunnel Loss**| Checkbox (`vpn-auto-recover`)| `Disabled` | Automatically reconnects and restores transfers if the VPN drops. |
| **Speed-Switch Cooldown** | Number (`vpn-cooldown`) | `5 min` | Cooldown period between speed-triggered server switches. |
| **Switches Per Window** | Number (`vpn-attempts`) | `3` | Maximum automatic speed switches permitted within the window (1–100). |
| **Switch Window** | Number (`vpn-window`) | `30 min` | Rolling window duration for speed-switch limits. |
| **Account Rotation Mode**| Dropdown (`vpn-refresh-mode`)| `Off` | Choose `Off`, `Every account`, or `Every N accounts`. |
| **Accounts Per Switch** | Number (`vpn-refresh-batch`)| `5` | Number of accounts checked per server when batch mode is active. |
| **Download Recovery** | Checkbox (`vpn-download-enabled`)| `Disabled` | Enables speed monitoring and server switching on downloads. |
| **Download Min Speed** | Number (`vpn-download-speed`)| `2.0 MB/s` | Speed threshold that triggers recovery if sustained. |
| **Download Sustained Time**| Number (`vpn-download-duration`)| `90 s` | Duration speed must stay below minimum to trigger a switch. |
| **Transfer Warmup** | Number (`vpn-warmup`) | `30 s` | Grace period after starting transfer before speed monitoring activates. |
| **Speed Averaging** | Number (`vpn-averaging`) | `30 s` | Rolling sample window used to calculate true transfer speed. |
| **Upload Recovery** | Checkbox (`vpn-upload-enabled`)| `Disabled` | Enables speed monitoring and boundary switching on uploads. |
| **Upload Min Speed** | Number (`vpn-upload-speed`)| `0.5 MB/s` | Upload threshold triggering a boundary switch. |
| **Upload Sustained Time** | Number (`vpn-upload-duration`)| `120 s` | Duration upload must stay below minimum to trigger boundary switch. |

---

### Network & Proxy Settings

- **Workers Proxy URL (`cfg-proxy`):** **[REQUIRED]** URL of your Cloudflare Worker deployment (e.g., `https://my-mega-proxy.workers.dev`). No trailing slash. This proxy handles range requests to bypass MEGA’s IP download limits.
- **OMDB API Key (`cfg-omdbKey`):** Free API key from [omdbapi.com](https://www.omdbapi.com/) for movie/TV metadata lookups.

### Folder & Storage Locations

- **Data Directory (`cfg-dataDir`):** **[REQUIRED]** Central folder where M3 stores logs and state:
  - `upload_log.csv`: History of all completed uploads and MEGA links.
  - `account_log.csv`: Managed account credentials, status, and storage usage.
  - `download_log.csv`: Record of downloaded links.
  - `import_log.csv`: Record of imported items.
  - `mediainfo_log.ndjson`: Cached MediaInfo extraction records.
- **Default Download Directory (`cfg-defaultDir`):** Default folder where downloaded files are saved.
- **Temporary Working Directory (`cfg-tempDir`):** Working folder for 7-Zip archiving, chunk splitting, and sparse file buffers.

### Download Engine Options

- **Concurrent File Downloads (`cfg-dlThreads`):** Number of files in a folder downloaded simultaneously (1–16, default: **4**). Single files use internal chunking.
- **Large-File Chunk Size (`cfg-dlChunkSize`):**
  - `512 MB`: High resume granularity; best for unstable connections.
  - `1 GB`: Balanced granularity.
  - `2 GB`: Default setting; optimal for high-speed connections.
  - `4 GB`: Fewer parts; recommended for 50 GB+ files.
- **Stream Mode Method (`cfg-streamMethod`):**
  - `Local HTTP Proxy`: Compatible with all platforms; streams through an internal loopback port.
  - `Sparse File (Linux-only)`: Zero-overhead direct filesystem allocation.
- **Streaming Chunk Size (`cfg-streamingChunkSize`):** Size of streaming chunks (10–1000 MB, default: **100 MB**). Smaller chunks allow players to start playback faster.
- **Launch Video When Ready (`cfg-launchWhenReady`):** Automatically launches your system video player once the initial stream buffer is satisfied.

### Upload Engine Options (Megatools & MEGAcmd)

- **Megatools Settings:**
  - **Worker Threads (`cfg-uploadWorkers`):** Number of parallel upload threads (1–100, default: **5**).
  - **Enable Boost Mode (`cfg-boostEnabled`):** When enabled, bundles small buffers into large chunk streams per worker. Highly recommended.
  - **Chunk Size (`cfg-uploadChunkSize`):** Size of chunk bundles (2 MB to 32 MB, default: **8 MB**).
  - **Buffer Size (`cfg-uploadBufferSize`):** Internal curl buffer per worker (256 KB to 2 MB, default: **512 KB**).
- **MEGAcmd Settings:**
  - **Worker Connections (`cfg-megacmdConnections`):** Parallel connection limit for the official MEGAcmd client (1–100, default: **10**).
- **Archive & Account Thresholds:**
  - **7z Split Size (`cfg-splitSizeGb`):** Size of split archive volumes (default: **20 GB**).
  - **Split Threshold (`cfg-splitThresholdGb`):** Files larger than this size are automatically compressed and split via 7z.
  - **Account Storage Threshold (`cfg-accountThresholdGb`):** Usable capacity per account before rotating to the next account (e.g., 19.5 GB for 20 GB free tiers).

### Tool Priority & Fallback Chains

Located in **Settings → Tool Priority**:
- **Account Creation:** Set preferred order between `megatools` and `megacmd`.
- **Upload Operations:** Reorder `megatools`, `megacmd`, and `rfork` using the **▲** and **▼** buttons. M3 tries the next tool after a definite failure; an uncertain rfork completion pauses uploads for inspection.

### Templates & Integrations (OMDB & BBCode)

- **Post Template (`cfg-postTemplate`):** Master template copied when clicking **📋 Post** on any generated link.
- **Title Template (`cfg-titleTemplate`):** Single-line title template copied via **📋 Title**.
- **Part Row Template (`cfg-linkRowTemplate`):** Determines how multi-part archives are listed inside the `{{Links Block}}` placeholder.
- **Available Variables:**
  - File info: `{{File Name}}`, `{{File Size}}`, `{{Link}}`, `{{Date}}`, `{{Part Label}}`
  - MediaInfo: `{{Video Codec}}`, `{{Resolution}}`, `{{Audio Format}}`, `{{Duration}}`, `{{Bitrate}}`, `{{Full MediaInfo}}`
  - OMDB info: `{{OMDB Title}}`, `{{OMDB Year}}`, `{{OMDB Plot}}`, `{{OMDB Rating}}`, `{{OMDB Poster}}`, `{{OMDB Cast}}`

### Appearance, Fonts & Layout

- **Theme Engine:** Fully editable CSS variables (Deep background, Surface, Accent color, Text colors, Borders). Supports export and import of theme JSON files.
- **Typography:** Choose system UI fonts, bundled typefaces, or custom font families.
- **Sidebar & Pagination:** Configurable sidebar width (180–500 px) and items-per-page limits for accounts, links, downloads, and MediaInfo records.

---

## Best Practices & Pro Tips

### 1. Optimize Upload Workers with VPN Latency
VPNs naturally increase network latency. When using `megatools` over a VPN:
- Keep **Boost Mode** enabled.
- Set **Chunk size** to **8 MB** or **16 MB**.
- Avoid setting **Worker threads** too high (stay between **4 and 6**). Excessively high worker counts over high-latency VPN tunnels can cause socket drops and timeouts.

### 2. Bypass Download Bandwidth Limits
MEGA strictly enforces bandwidth limits per IP address (typically 1.5 GB to 5 GB every several hours for free connections):
- **Always configure your Cloudflare Worker proxy.** This distributes data requests across Cloudflare’s CDN infrastructure.
- If your Cloudflare Worker route is throttled, enable **Download Speed Recovery** in Proton VPN settings with a threshold of **2.0 MB/s** and a sustained duration of **90 s**. M3 will cleanly migrate the download to a new VPN IP address while preserving partial chunks.

### 3. Smart Country-Balanced Server Selection
When using large server pools (e.g., *All regular servers*):
- Always use the **Country-balanced shuffle** order.
- In pure random mode, countries with thousands of servers (like the US or Netherlands) would be chosen 90% of the time. Country-balanced mode cycles through nations fairly, giving you diverse geographic routes and avoiding over-congested subnets.

### 4. Dynamic Recovery During Attention States
If Proton VPN fails to connect after cycling through all candidates in a round, M3 enters a `Waiting to retry` or `Needs attention` state:
- Do **not** cancel or restart your downloads or account batches.
- Simply click **Edit waiting pool**, select a different country or add new server IDs, and click **Apply pool and retry**.
- M3 will wake the paused job and immediately attempt connection with the new pool without losing your progress.

### 5. Seamless Stream Mode Seeking
When streaming video files:
- Use **100 MB** chunks for typical 1080p content; use **200 MB** chunks for 4K high-bitrate media.
- In **Local HTTP Proxy** mode, wait until the status displays `Streaming ready (head and tail buffered)` before attempting deep timeline scrubs in your media player.

### 6. Protecting Account Integrity
When uploading large batches across multiple accounts:
- Keep **Account Storage Threshold** set to **19.5 GB** (for 20 GB accounts). Leaving a 500 MB buffer prevents uploads from failing due to folder metadata overhead.
- Enable **Account Rotation** (`Every account` or `Every 2 accounts`) to ensure each account's registration and upload activity originates from a distinct VPN IP.

---

## Troubleshooting & FAQ

### Q: What happens to Proton VPN when I close M3?
**A:** M3 stops active work, disconnects Proton, and verifies Disconnected before exiting. The window stays visible during cleanup. If disconnection cannot be confirmed, M3 stays open with a retry option and access to the VPN terminal. This also applies when App control is disabled on Linux. See [VPN shutdown](docs/vpn-shutdown.md) for supported exit paths and forced-termination limitations.

### Q: Why is "VPN-required" mode disabled in Settings?
**A:** M3 strictly validates security claims. VPN-required mode demands verified packet-level OS kill-switch protection to guarantee zero packet leakage during startup, switching, and tunnel loss. Until platform-level kill switch hooks are finalized, M3 operates in **Manual control** mode, which safely pauses all M3 traffic if a switch is pending or uncertain.

### Q: Proton CLI reports an error on disconnect, but the terminal shows disconnected.
**A:** Official Proton CLI v1.0.5 has a known upstream quirk where its asynchronous teardown hook exits with code `1` even after successfully disconnecting. M3 contains an intelligent status reconciler that detects this exit code, performs a secondary status verification, and correctly marks the system as `Disconnected` without throwing false errors.

### Q: "Proton CLI is not ready / GUI conflict detected."
**A:** Proton VPN cannot run both the official desktop GUI client and the command-line interface simultaneously. If the GUI app is running in the background:
1. Quit the Proton VPN desktop GUI completely (check your Linux system tray).
2. Click **Check setup / status** in M3's Proton VPN settings panel to confirm the CLI is ready.

### Q: A download shows "VPN wait" in the header. What does it mean?
**A:** This indicates that the download watchdog detected low speeds or tunnel loss and has safely paused transfer streams. It is currently negotiating a new server with Proton VPN. Your downloaded chunks and CBC-MAC checkpoints are safely held in memory and disk; transfers will automatically resume once the tunnel is verified.

### Q: Why do uploads only switch VPNs between files?
**A:** Unlike downloads (which support byte-range restarts), MEGA upload tools (`megatools`, `MEGAcmd`) cannot reliably resume half-uploaded single files after an IP address switch without risking corrupted or duplicated entries on your account. M3 safely allows the active file to finish, commits its CSV record, and switches servers immediately before the next file begins.

---

*M3 — Mega Manager Max · Built for speed, privacy, and transfer reliability.*
