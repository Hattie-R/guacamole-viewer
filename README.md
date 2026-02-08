# TailBurrow 🦊

> **Just another vibe-code project.**

TailBurrow is a lightning-fast, local-first desktop media library for archiving and browsing your furry art favorites. It stores files and metadata in a local SQLite library, providing offline access, advanced tag-based searching, and a slideshow viewer.

It seamlessly syncs with **e621** and **FurAffinity**, ensuring your favorites stay accessible even if they disappear from the internet.

Built with **Tauri**, **React**, and **Rust**.

## ✨ Features

*   **Offline Archiving:** Downloads images/videos and metadata to your local drive.
*   **Hybrid Sync:** Smartly imports from **FurAffinity** and **e621**, prioritizing higher-quality e621 metadata when duplicates are found.
*   **Advanced Search:** SQL-powered search supports tags, negation (`-tag`), wildcards (`*`), and metadata filters.
*   **Feeds:** Discover new posts directly within the app via e621 queries.
*   **Rich Viewer:** Slideshow mode, video controls, auto-mute, and detailed source/artist links.

## 🚀 How to Use

1.  **Download** the latest installer from the [Releases](https://github.com/Hattie-R/TailBurrow/releases) page.
2.  **Install & Launch** TailBurrow.
3.  **Library Setup:** On first run, create or select a folder to store your library.
4.  **Connect e621:**
    *   Go to **Settings** (gear icon).
    *   Enter your e621 username and API Key.
    *   *(To find your Key: [e621 Settings](https://e621.net/users/settings) → Basic → Account → API Keys)*.
5.  **Sync:** Scroll to "Sync Favorites" and click **Start**.
6.  **Enjoy:** Once finished, your collection is ready for offline browsing!

### 🐾 Importing from FurAffinity

TailBurrow can scrape your FA favorites using your session cookies.

1.  Log into FurAffinity in your web browser.
2.  Press `F12` (Developer Tools) and go to the **Application** (or Storage) tab.
3.  Expand **Cookies** and look for `furaffinity.net`.
4.  Copy the values for cookie `a` and cookie `b`.
5.  Paste them into TailBurrow **Settings → FurAffinity Import**.

## 🛠️ How Sync Works

TailBurrow uses a **"Hybrid Upgrade"** strategy to ensure the best possible metadata:

1.  **Scanning:** The app uses your session cookies to locally scan your FA favorites.
2.  **Hashing:** It calculates the MD5 hash of every image found.
3.  **Cross-Reference:** It checks the e621 database for that hash.
    *   **Match Found:** The app **"upgrades"** the import. It downloads the file from e621 instead (often higher quality) and applies rich tags, ratings, and source links.
    *   **No Match:** The image is preserved as a **FurAffinity Exclusive**, with the artist name and rating scraped directly from the submission page.

## 🗺️ Roadmap

*   **Performance:** Switch library view to a virtualized masonry grid with cached thumbnails for massive collections.
*   **More Sources:** Support for Twitter/X and Bluesky archiving.

## 📄 License

[MIT](LICENSE)