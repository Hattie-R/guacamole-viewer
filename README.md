# Guaguacamole Viewer
Just another *vibe-code* project
This template should help get you started developing with Tauri, React and Typescript in Vite.

Guacamole Viewer is a local-first desktop media library for archiving and browsing your favorites. It imports your existing JSON database, stores files and metadata in a local SQLite library, and provides fast tag-based searching, a viewer with slideshow controls, and safe deletion via an in-app trash folder. It also includes an e621 feeds tab to discover new posts and add them to your local collection, so your favorites stay accessible even if they disappear online.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)


## TODO list
1) Feeds UX + Infinite Scroll stability (next)
    Replace CSS columns-* feed layout with a real masonry layout (e.g. react-masonry-css) so new pages append at the bottom without reshuffling.
    Add “Loading more…” footer indicator per feed.
    Add dedupe guarantees (already mostly done by post id) + “end of results” message.
    Add protection for order:random (disable infinite scroll or warn).

2) Make the feed ⭐ actually add to local library (core)
    Backend command: download + insert e621 post into SQLite + copy file into media/.
    Frontend: star click triggers that command; star state checks DB (remote_url or (source, source_id)).
    Store full e621 metadata including sources[] (you want this for provenance).

3) Proper download manager (your spec: 4 concurrent)
    Persistent download queue table + UI panel.
    4 concurrent downloads, retry/backoff, failure list (retry/cancel).
    Non-blocking UI: clicking star just enqueues.

4) Thumbnails & previews (performance + masonry grid for your local library)
    Generate and cache:
        static thumbnails for images
        animated muted previews for videos (and animated GIF behavior only when visible)
    Switch library view from “single viewer-first” to a virtualized masonry grid (e.g. masonic) fed by cached thumbs/previews.
    Settings toggles: animated previews on/off, preview quality limits.

5) Search improvements (SQLite FTS)
    Replace current JS tag filtering with backend FTS search + pagination:
        query string -> SQL/FTS
        sorting options: newest/oldest/random/fav_count/score
    Add filters: type (image/gif/video), rating, artist.

6) Trash UX (complete the spec)
    Build a Trash screen:
        list trashed items
        restore / permanently delete
    Implement auto-expire 7 days background job + “Empty trash now”.

7) “Edit post” UI (metadata maintenance)
    Edit tags (with autocomplete), rating, sources URLs.
    Optional: “Re-fetch metadata from e621” (by id / md5) when available.

8) Library maintenance & robustness
    Path repair workflow when library root moved:
        detect missing root
        prompt user to locate
        re-apply scopes automatically
    Dedupe management (flag duplicates by md5 and let user decide).
    Optional tool: “Rename files to match metadata” (opt-in).

9) Security / privacy hardening
    Optional app lock (gate only).
    Log redaction + rotation; log location setting.

10) Packaging
    Windows installer build + release process.
