# TailBurrow
TailBurrow is a local-first desktop media library for archiving and browsing your favorites. It stores files and metadata in a local SQLite library, and provides fast tag-based searching, a viewer with slideshow controls. It also includes an e621 feeds tab to discover new posts and add them to your local collection, so your favorites stay accessible even if they disappear online.

Developed with Tauri, React and Typescript in Vite. Just another *vibe-code* project.

## How to Use
1. Download latest *Release*
2. Go through installation process
3. Open *TailBurrow*
4. If never used create a folder and assign it as your Library folder
5. Go to *Settings* (top right button) and login to your e621 using username and API key (*To find your API key you may go to [e621 settings](https://e621.net/users/settings), then Basic → Account → API Keys*)
6. In settings scroll down to **"Sync Favourites"** and press Start (*you can limit the amount of favourites to be synced*)
7. After sync is finished you will see all of your favourites in the viewer, enjoy :3

## Where to Get FurAffinity Cookies from?
1. Login to your FA account and go to your favourites page
2. Press F12 or Ctrl + Shift + I and go to Network
3. Reload page and go back to the Developer Tool
4. Scroll up to the first request
5. Copy Cookies from the request header

## How FurAffinity Sync Works

TailBurrow uses a "Hybrid" strategy to ensure the best possible metadata for your collection. Since FurAffinity lacks a public API, the app uses your session cookies to securely scan your favorites locally. For every image found, TailBurrow calculates its MD5 hash and cross-references it with the e621 database. If a match is found on e621, the app automatically "upgrades" the import. It downloads the file from e621 instead, ensuring you get rich tagging, ratings, and metadata, while still linking back to the original FA source. If no match is found, the image is preserved as a FurAffinity Exclusive, with the artist name and rating scraped directly from the submission page.


## TODO list
1. Thumbnails & previews (performance + masonry grid for your local library)
    Generate and cache:
        static thumbnails for images
        animated muted previews for videos (and animated GIF behavior only when visible)
    Switch library view from “single viewer-first” to a virtualized masonry grid (e.g. masonic) fed by cached thumbs/previews.
    Settings toggles: animated previews on/off, preview quality limits.

2. Search improvements (SQLite FTS)
    Add filters: type (image/gif/video), rating, artist.

3. Trash UX (complete the spec)
    Build a Trash screen:
        list trashed items
        restore / permanently delete
    Implement auto-expire 7 days background job + “Empty trash now”.

4. “Edit post” UI (metadata maintenance)
    Edit rating, sources URLs.
    Optional: “Re-fetch metadata from e621” (by id / md5) when available.

5. Library maintenance & robustness
    Path repair workflow when library root moved:
        detect missing root
        prompt user to locate
        re-apply scopes automatically
    Dedupe management (flag duplicates by md5 and let user decide).
    Optional tool: “Rename files to match metadata” (opt-in).

6. Security / privacy hardening
    Optional app lock (gate only).
    Log redaction + rotation; log location setting.

7. Support for Twitter and BlueSky

Favourite in both e621 and furafinity
feeds query is not obvious that it's e621
Naming and icon abbiguous
Background