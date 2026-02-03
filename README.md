# Guaguacamole Viewer
Guacamole Viewer is a local-first desktop media library for archiving and browsing your favorites. It stores files and metadata in a local SQLite library, and provides fast tag-based searching, a viewer with slideshow controls. It also includes an e621 feeds tab to discover new posts and add them to your local collection, so your favorites stay accessible even if they disappear online.

Developed with Tauri, React and Typescript in Vite. Just another *vibe-code* project.

## TODO list
1) Feeds UX

2) Thumbnails & previews (performance + masonry grid for your local library)
    Generate and cache:
        static thumbnails for images
        animated muted previews for videos (and animated GIF behavior only when visible)
    Switch library view from “single viewer-first” to a virtualized masonry grid (e.g. masonic) fed by cached thumbs/previews.
    Settings toggles: animated previews on/off, preview quality limits.

3) Search improvements (SQLite FTS)
    Replace current JS tag filtering with backend FTS search + pagination:
        query string -> SQL/FTS
        sorting options: newest/oldest/random/fav_count/score
    Add filters: type (image/gif/video), rating, artist.

4) Trash UX (complete the spec)
    Build a Trash screen:
        list trashed items
        restore / permanently delete
    Implement auto-expire 7 days background job + “Empty trash now”.

5) “Edit post” UI (metadata maintenance)
    Edit tags (with autocomplete), rating, sources URLs.
    Optional: “Re-fetch metadata from e621” (by id / md5) when available.

6) Library maintenance & robustness
    Path repair workflow when library root moved:
        detect missing root
        prompt user to locate
        re-apply scopes automatically
    Dedupe management (flag duplicates by md5 and let user decide).
    Optional tool: “Rename files to match metadata” (opt-in).

7) Security / privacy hardening
    Optional app lock (gate only).
    Log redaction + rotation; log location setting.

## Current Issues:
1) Fullscreen doesn't work with feeds
2) UX of Feed
    Cannot preview videos
3) Need an option to clear credentials