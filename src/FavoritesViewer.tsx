import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Search, Upload, Play, Pause, ChevronLeft, ChevronRight,
  X, Tag, Trash2, Rss, Plus, Star, Maximize, Settings,
  Database, Loader2, Volume2, VolumeX, Clock
} from "lucide-react";

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import Masonry from "react-masonry-css";

/* =========================
   Types
========================= */

type AppConfig = { library_root?: string | null };

type ItemDto = {
  item_id: number;
  source: string;
  source_id: string;
  remote_url?: string | null;
  file_abs: string;
  ext?: string | null;
  tags: string[];
  artists: string[];
  sources: string[];
  rating?: string | null;
  fav_count?: number | null;
  score_total?: number | null;
  timestamp?: string | null;
  added_at: string;
};

type LibraryItem = {
  id?: number;
  item_id: number;
  source: string;
  source_id: string;
  remote_url?: string | null;
  url: string;              // convertFileSrc result
  ext?: string | null;
  tags: string[];
  artist: string[];
  sources: string[];
  rating?: string | null;
  fav_count?: number | null;
  score?: { total: number };
  timestamp?: string | null;
};

type SyncStatus = {
  running: boolean;
  cancelled: boolean;
  max_new_downloads?: number | null;
  scanned_pages: number;
  scanned_posts: number;
  skipped_existing: number;
  new_attempted: number;
  downloaded_ok: number;
  failed_downloads: number;
  unavailable: number;
  last_error?: string | null;
};

type UnavailableDto = {
  source: string;
  source_id: string;
  seen_at: string;
  reason: string;
  sources: string[];
};

type Feed = { id: number; name: string; query: string };
type FeedPagingState = { beforeId: number | null; done: boolean };
type E621CredInfo = { username?: string | null; has_api_key: boolean };

export default function FavoritesViewer() {
  const [activeTab, setActiveTab] = useState('viewer');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [searchTags, setSearchTags] = useState('');
  const [sortOrder, setSortOrder] = useState(() => {
    try {
      return localStorage.getItem('preferred_sort_order') || 'default';
    } catch {
      return 'default';
    }
  });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isSlideshow, setIsSlideshow] = useState(false);
  const [slideshowSpeed, setSlideshowSpeed] = useState(3000);
  const [autoMuteVideos, setAutoMuteVideos] = useState(true);
  const [waitForVideoEnd, setWaitForVideoEnd] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [fadeIn, setFadeIn] = useState(true);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageCache, setImageCache] = useState<Record<string, boolean>>({});
  
  // Feed state
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedPosts, setFeedPosts] = useState<Record<number, any[]>>({});
  const [loadingFeeds, setLoadingFeeds] = useState<Record<number, boolean>>({});
  const [newFeedQuery, setNewFeedQuery] = useState('');
  const [newFeedName, setNewFeedName] = useState('');
  const [apiUsername, setApiUsername] = useState('');
  const [apiKey, setApiKey] = useState('');

  // New
  const [showSettings, setShowSettings] = useState(false);
  const [libraryRoot, setLibraryRoot] = useState("");
  const [feedPaging, setFeedPaging] = useState<Record<number, FeedPagingState>>({}); 
  const [downloadedE621Ids, setDownloadedE621Ids] = useState<Set<number>>(new Set());
  const [feedActionBusy, setFeedActionBusy] = useState<Record<number, boolean>>({});
  const [syncMaxNew, setSyncMaxNew] = useState<string>(""); // blank = unlimited
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [unavailableList, setUnavailableList] = useState<UnavailableDto[]>([]);
  const syncWasRunningRef = useRef(false);
  const [viewerOverlay, setViewerOverlay] = useState(false); // full-window viewer inside app
  const [showHud, setShowHud] = useState(true);
  const hudHoverRef = useRef(false);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const HUD_TIMEOUT_MS = 2000; // 3–5 seconds; adjust
  const feedBreakpoints = {
    default: 3,
    1024: 3,
    768: 2,
    520: 1,
  };

  const scheduleHudHide = useCallback(() => {
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);

    hudTimerRef.current = setTimeout(() => {
      if (!hudHoverRef.current) setShowHud(false);
    }, HUD_TIMEOUT_MS);
  }, []);

  const pokeHud = useCallback(() => {
    setShowHud(true);
    scheduleHudHide();
  }, [scheduleHudHide]);

  const refreshSyncStatus = async () => {
    const st = await invoke<SyncStatus>("e621_sync_status");
    setSyncStatus(st);
  };

  const startSync = async () => {
    const n = syncMaxNew.trim() === "" ? null : Number(syncMaxNew);
    if (syncMaxNew.trim() !== "" && (!Number.isFinite(n) || n! <= 0)) {
      alert("Stop-after-N must be a positive number or blank.");
      return;
    }
    
    await invoke("e621_sync_start", { maxNewDownloads: n });
    syncWasRunningRef.current = true;
    await refreshSyncStatus();
  };

  const cancelSync = async () => {
    await invoke("e621_sync_cancel");
    await refreshSyncStatus();
  };

  const loadUnavailable = async () => {
    const list = await invoke<UnavailableDto[]>("e621_unavailable_list", { limit: 200 });
    setUnavailableList(list);
    setShowUnavailable(true);
  };

  const [e621CredInfo, setE621CredInfo] = useState<E621CredInfo>({
    username: null,
    has_api_key: false,
  });

  const [credWarned, setCredWarned] = useState(false);

  const refreshE621CredInfo = async () => {
    const info = await invoke<E621CredInfo>("e621_get_cred_info");
    setE621CredInfo(info);
    // prefill username, but NEVER prefill the key
    if (info.username) setApiUsername(info.username);
  };

  const saveE621Credentials = async () => {
    await invoke("e621_set_credentials", {
      username: apiUsername,
      apiKey: apiKey, // can be blank -> backend keeps existing key
    });
    setApiKey(""); // clear for safety
    await refreshE621CredInfo();
    alert("Saved e621 credentials.");
  };

  const testE621Credentials = async () => {
    const res = await invoke<{ ok: boolean; message: string }>("e621_test_connection");
    alert(res.message);
  };

  const favoriteOnE621 = async (postId: number) => {
    await invoke("e621_favorite", { postId });
  };

  const ensureFavorite = async (feedId: number, post: any) => {
    const id = post.id as number;

    try {
      setFeedActionBusy((prev) => ({ ...prev, [id]: true }));

      // 1) download into library if missing
      if (!downloadedE621Ids.has(id)) {
        if (!post?.file?.url) {
          throw new Error("This post has no original file URL (deleted/blocked).");
        }

        await invoke("add_e621_post", {
          post: {
            id: post.id,
            file_url: post.file.url,
            file_ext: post.file.ext,
            file_md5: post.file.md5,
            rating: post.rating,
            fav_count: post.fav_count,
            score_total: post.score?.total,
            created_at: post.created_at,
            sources: post.sources || [],
            tags: {
              general: post.tags?.general || [],
              species: post.tags?.species || [],
              character: post.tags?.character || [],
              artist: post.tags?.artist || [],
              meta: post.tags?.meta || [],
              lore: post.tags?.lore || [],
              copyright: post.tags?.copyright || [],
            },
          },
        });

        await loadData(); // updates downloadedE621Ids + DB badge
      }

      // 2) ensure remote favorite
      await favoriteOnE621(id);

      // 3) update UI star immediately
      setFeedPosts((prev) => ({
        ...prev,
        [feedId]: (prev[feedId] || []).map((p: any) =>
          p.id === id ? { ...p, is_favorited: true } : p
        ),
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Failed to favorite post:", error);
      
      // More helpful error messages
      if (msg.includes("network") || msg.includes("fetch")) {
        alert("Network error. Please check your connection.");
      } else if (msg.includes("no file URL") || msg.includes("deleted") || msg.includes("blocked")) {
        alert("This post is not available (may be deleted or blocked).");
      } else {
        alert(`Failed to favorite: ${msg}`);
      }
    } finally {
      setFeedActionBusy((prev) => ({ ...prev, [id]: false }));
    }
  };

  function InfiniteSentinel({
    onVisible,
    disabled,
  }: {
    onVisible: () => void;
    disabled?: boolean;
  }) {
    const ref = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (disabled) return;
      const el = ref.current;
      if (!el) return;

      const obs = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) onVisible();
        },
        { root: null, rootMargin: "800px 0px", threshold: 0 }
      );

      obs.observe(el);
      return () => obs.disconnect();
    }, [onVisible, disabled]);

    return <div ref={ref} className="h-10" />;
  }

  // new functions

    const refreshLibraryRoot = async () => {
    const cfg = await invoke<AppConfig>("get_config");
    setLibraryRoot(cfg.library_root || "");
  };

  const changeLibraryRoot = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;

    await invoke("set_library_root", { libraryRoot: dir });
    await refreshLibraryRoot();
    await loadData();
  };

  useEffect(() => {
    if (!showSettings) return;

    let t: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      try {
        const st = await invoke<SyncStatus>("e621_sync_status");
        setSyncStatus(st);

        // Detect: running -> finished
        if (syncWasRunningRef.current && !st.running) {
          // Sync just finished, refresh library view
          await loadData();
        }

        syncWasRunningRef.current = st.running;
      } catch {
        // ignore
      }
    };

    tick();
    
    t = setInterval(tick, 1000);

    return () => {
      if (t) clearInterval(t);
    };
  }, [showSettings]);

  useEffect(() => {
    if (!viewerOverlay) return;

    const onKeyDown = (e: KeyboardEvent) => {
      pokeHud();
      if (e.key === "Escape") {
        e.preventDefault();
        // Exit fullscreen first if active
        if (document.fullscreenElement) {
          document.exitFullscreen();
        }
        // Close the overlay (fullscreen listener will handle sync)
        setViewerOverlay(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewerOverlay, pokeHud]);

  useEffect(() => {
    return () => {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (viewerOverlay) pokeHud();
  }, [viewerOverlay]);

  useEffect(() => {
    loadData().catch(console.error);
    refreshLibraryRoot().catch(console.error);
    loadFeeds();
    refreshE621CredInfo().catch(console.error);
  }, []);

  // Calculate filtered items (must be before functions that use it)
const filteredItems = useMemo(() => {
  let filtered = items;

  if (searchTags.trim()) {
    const searchTerms = searchTags.toLowerCase().split(' ').filter(t => t);
    filtered = filtered.filter(item => 
      searchTerms.every(term => 
        item.tags?.some(tag => tag.toLowerCase().includes(term))
      )
    );
  }

  if (selectedTags.length > 0) {
    filtered = filtered.filter(item =>
      selectedTags.every(tag =>
        item.tags?.includes(tag)
      )
    );
  }

  // Apply sorting
  if (sortOrder === 'random') {
    filtered = [...filtered].sort(() => Math.random() - 0.5);
  } else if (sortOrder === 'score') {
    filtered = [...filtered].sort((a, b) => {
      const scoreA = a.score?.total || 0;
      const scoreB = b.score?.total || 0;
      return scoreB - scoreA;
    });
  } else if (sortOrder === 'newest') {
    filtered = [...filtered].sort((a, b) => {
      const dateA = new Date(a.timestamp || 0);
      const dateB = new Date(b.timestamp || 0);
      return dateB.getTime() - dateA.getTime();
    });
  } else if (sortOrder === 'oldest') {
    filtered = [...filtered].sort((a, b) => {
      const dateA = new Date(a.timestamp || 0);
      const dateB = new Date(b.timestamp || 0);
      return dateA.getTime() - dateB.getTime();
    });
  }

  return filtered;
}, [items, searchTags, selectedTags, sortOrder]);

// Reset to first item when filters change
useEffect(() => {
  setCurrentIndex(0);
}, [filteredItems]);

  useEffect(() => {
  if (!isSlideshow || filteredItems.length === 0) return;
  
  // If we should wait for videos to end, don't use interval for video items
  const currentItem = filteredItems[currentIndex];
  const isCurrentVideo = currentItem && ["mp4", "webm"].includes((currentItem.ext || "").toLowerCase());
  
  if (waitForVideoEnd && isCurrentVideo) {
    // Let the video's onEnded event handle navigation
    return;
  }
  
  const interval = setInterval(() => {
    setCurrentIndex((prev) => (prev + 1) % filteredItems.length);
    setFadeIn(false);
    setTimeout(() => setFadeIn(true), 150);
  }, slideshowSpeed);
  
  return () => clearInterval(interval);
}, [isSlideshow, slideshowSpeed, filteredItems.length, currentIndex, waitForVideoEnd]);

  // Preload adjacent images with caching
useEffect(() => {
    if (filteredItems.length === 0) return;

    const preloadIndexes = [
      currentIndex,
      (currentIndex + 1) % filteredItems.length,
      (currentIndex + 2) % filteredItems.length,
      (currentIndex - 1 + filteredItems.length) % filteredItems.length
    ];
    
    preloadIndexes.forEach(idx => {
      const item = filteredItems[idx];
      if (!item || imageCache[item.url]) return;

      const ext = (item.ext || "").toLowerCase();
      if (["mp4", "webm"].includes(ext)) return;
      
      const img = new Image();
      img.src = item.url;
      img.onload = () => {
        setImageCache(prev => ({...prev, [item.url]: true}));
      };
    });
  }, [currentIndex, filteredItems, imageCache]);

  // Save sort order preference
  useEffect(() => {
    try {
      localStorage.setItem('preferred_sort_order', sortOrder);
    } catch (error) {
      console.error('Failed to save sort order preference:', error);
    }
  }, [sortOrder]);

  const goToNext = useCallback((manual = false) => {
    if (viewerOverlay && manual) pokeHud();
    setFadeIn(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % filteredItems.length);
      setFadeIn(true);
    }, 150);
  }, [viewerOverlay, pokeHud, filteredItems.length]);

  const goToPrev = useCallback((manual = false) => {
    if (viewerOverlay && manual) pokeHud();
    setFadeIn(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      setFadeIn(true);
    }, 150);
  }, [viewerOverlay, pokeHud, filteredItems.length]);

  const toggleFullscreen = () => {
    if (viewerOverlay) pokeHud();
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };
  const openExternalUrl = async (url: string) => {
    try {
      await openUrl(url);
    } catch (error) {
      console.error("Failed to open URL:", error);
      alert("Failed to open link in browser");
    }
  };

  const getSocialMediaName = (url: string): string => {
    try {
      const urlLower = url.toLowerCase();
      
      if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) return 'Twitter';
      if (urlLower.includes('furaffinity.net')) return 'FurAffinity';
      if (urlLower.includes('patreon.com')) return 'Patreon';
      if (urlLower.includes('inkbunny.net')) return 'Inkbunny';
      if (urlLower.includes('bsky.app') || urlLower.includes('bluesky')) return 'Bluesky';
      if (urlLower.includes('deviantart.com') || urlLower.includes('deviantar.com')) return 'DeviantArt';
      if (urlLower.includes('artstation.com')) return 'ArtStation';
      if (urlLower.includes('pixiv.net')) return 'Pixiv';
      if (urlLower.includes('tumblr.com')) return 'Tumblr';
      if (urlLower.includes('reddit.com')) return 'Reddit';
      if (urlLower.includes('instagram.com')) return 'Instagram';
      if (urlLower.includes('weasyl.com')) return 'Weasyl';
      if (urlLower.includes('sofurry.com')) return 'SoFurry';
      if (urlLower.includes('newgrounds.com')) return 'Newgrounds';
      if (urlLower.includes('mastodon')) return 'Mastodon';
      if (urlLower.includes('cohost.org')) return 'Cohost';
      if (urlLower.includes('itaku.ee')) return 'Itaku';
      
      // Try to extract domain name as fallback
      const hostname = new URL(url).hostname.replace('www.', '');
      const domain = hostname.split('.')[0];
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    } catch {
      return 'Source';
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      // If we exit fullscreen, also close the viewer overlay
      if (!document.fullscreenElement && viewerOverlay) {
        setViewerOverlay(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [viewerOverlay]);

    const loadData = async () => {
      try {
        const rows = await invoke<ItemDto[]>("list_items");

        const mapped = rows.map((r) => {
        const localUrl = convertFileSrc(r.file_abs);

        return {
        ...r,
        // Keep your existing UI working:
        url: localUrl,                // used by <img>/<video> and preloading
        ext: r.ext,
        id: Number(r.source_id),      // used for e621 links
        artist: r.artists || [],
        tags: r.tags || [],
        sources: r.sources || [],
        timestamp: r.timestamp,
        // Optional: adapt score sorting
        score: { total: r.score_total ?? 0 },
        };
    });

    setItems(mapped);

    const downloaded = new Set<number>();
    for (const it of mapped) {
      if (it.source === "e621") downloaded.add(Number(it.source_id));
    }
    setDownloadedE621Ids(downloaded);

    // Build tag list (same logic you already had)
    const tags = new Set<string>();
    mapped.forEach((item) => item.tags?.forEach((tag) => tags.add(tag)));

    const sortedTags: string[] = Array.from(tags).sort((a, b) => {
      const countA = mapped.filter((item) => item.tags?.includes(a)).length;
      const countB = mapped.filter((item) => item.tags?.includes(b)).length;
      return countB - countA;
    });
    setAllTags(sortedTags);
      } catch (error) {
        console.error("Failed to load library:", error);
        alert("Failed to load library. Please check your library settings.");
      }
    };

  const loadFeeds = () => {
    try {
      const stored = localStorage.getItem('e621_feeds');
      if (stored) {
        setFeeds(JSON.parse(stored));
      }
    } catch (error) {
      console.log('No saved feeds yet');
    }
  };

  const saveFeeds = (newFeeds: Feed[]) => {
    localStorage.setItem("e621_feeds", JSON.stringify(newFeeds));
    setFeeds(newFeeds);
  };

  const addFeed = () => {
    if (!newFeedQuery.trim()) return;
    
    const feed = {
      id: Date.now(),
      name: newFeedName.trim() || newFeedQuery,
      query: newFeedQuery.trim()
    };
    
    saveFeeds([...feeds, feed]);
    setNewFeedQuery('');
    setNewFeedName('');
  };

  const removeFeed = (feedId: number) => {
    saveFeeds(feeds.filter((f) => f.id !== feedId));
    setFeedPosts((prev) => {
      const copy = { ...prev };
      delete copy[feedId];
      return copy;
    });
  };

  const fetchFeedPosts = async (feedId: number, query: string, { reset = false }: { reset?: boolean } = {}) => {
    if (!e621CredInfo.username || !e621CredInfo.has_api_key) {
    if (!credWarned) {
      alert("Set e621 credentials in Settings first.");
      setCredWarned(true);
    }
    return;
  }
    // prevent double loads
    if (loadingFeeds[feedId]) return;

    const paging = feedPaging[feedId] || { beforeId: null, done: false };
    if (!reset && paging.done) return;

    // (Optional) Disable infinite scroll for random
    if (!reset && /\border:random\b/i.test(query)) return;

    setLoadingFeeds(prev => ({ ...prev, [feedId]: true }));

    try {
      const LIMIT = 50;
      const beforeId = reset ? null : paging.beforeId;
      const pageParam = beforeId ? `b${beforeId}` : "1";

      const data = await invoke<any>("e621_fetch_posts", {
        tags: query,
        limit: LIMIT,
        page: pageParam,
      });

      const newPosts = data.posts || [];

      // append + dedupe by id
      // append + dedupe by id
      setFeedPosts(prev => {
        const existing = reset ? [] : (prev[feedId] || []);
        const merged = [...existing, ...newPosts];
        
        // More efficient deduplication using Map
        const uniqueMap = new Map();
        merged.forEach(p => uniqueMap.set(p.id, p));
        return { ...prev, [feedId]: Array.from(uniqueMap.values()) };
      });

      // update cursor
      const minId = newPosts.reduce((m: number, p: any) => Math.min(m, p.id), Number.POSITIVE_INFINITY);

      setFeedPaging(prev => ({
        ...prev,
        [feedId]: {
          beforeId: (minId !== Number.POSITIVE_INFINITY) ? minId : paging.beforeId,
          done: newPosts.length < LIMIT || newPosts.length === 0,
        },
      }));
    } catch (error) {
      console.error('Error fetching feed:', error);
      const msg = error instanceof Error ? error.message : String(error);
      alert("Error fetching feed: " + msg);
    } finally {
      setLoadingFeeds(prev => ({ ...prev, [feedId]: false }));
    }
  };

  // Reset to first item when filters change
  useEffect(() => {
    setCurrentIndex(0);
  }, [filteredItems]);

  const toggleTag = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag)
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  };

  const deleteCurrentItem = async () => {
    const itemToDelete = filteredItems[currentIndex];
    if (!itemToDelete) return;

    await invoke("trash_item", { itemId: itemToDelete.item_id });
    await loadData();
  };

  const currentItem = filteredItems[currentIndex];
  const ext = (currentItem?.ext || "").toLowerCase();
  const isVideo = ext === "mp4" || ext === "webm";


  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header with Tabs */}
      <div className="border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center justify-between pt-4">
            {/* Tabs (left) */}
            <div className="flex gap-4">
              <button
                onClick={() => setActiveTab('viewer')}
                className={`px-4 py-2 font-medium border-b-2 transition ${
                  activeTab === 'viewer'
                    ? 'border-purple-500 text-purple-400'
                    : 'border-transparent text-gray-400 hover:text-gray-300'
                }`}
              >
                Viewer
              </button>

              <button
                onClick={() => setActiveTab('feeds')}
                className={`px-4 py-2 font-medium border-b-2 transition flex items-center gap-2 ${
                  activeTab === 'feeds'
                    ? 'border-purple-500 text-purple-400'
                    : 'border-transparent text-gray-400 hover:text-gray-300'
                }`}
              >
                <Rss className="w-4 h-4" />
                Feeds
              </button>
            </div>

            {/* Settings button (right) */}
            <button
              onClick={() => setShowSettings(true)}
              className="p-2 text-gray-400 hover:text-gray-200"
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setShowSettings(false)}
            />
            <div className="relative z-10 w-full max-w-xl max-h-[90vh] bg-gray-800 border border-gray-700 rounded-lg flex flex-col">
              <div className="flex items-center justify-between p-5 border-b border-gray-700 flex-shrink-0">
                <h2 className="text-lg font-semibold">Settings</h2>
                <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-200">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="overflow-y-auto p-5 space-y-3">
              <div className="space-y-3">
                <div>
                  <div className="text-sm text-gray-400 mb-1">Library folder</div>
                  <div className="text-xs text-gray-200 break-all bg-gray-900 border border-gray-700 rounded p-2">
                    {libraryRoot || "(not set)"}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={changeLibraryRoot}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded"
                  >
                    Change Library Folder
                  </button>
                  <button
                    onClick={() => setShowSettings(false)}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded"
                  >
                    Close
                  </button>
                </div>

                <p className="text-xs text-gray-500">
                  Changing library folder will switch to the database/media inside that folder.
                </p>
              </div>
                {/* Default Order */}
              <div className="border-t border-gray-700 pt-4 mt-4">
                <h3 className="text-lg font-semibold mb-2">Viewer Preferences</h3>
                
                <div className="space-y-3">
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block">Default sort order</label>
                    <select
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value)}
                      className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
                    >
                      <option value="default">Default Order</option>
                      <option value="random">Random</option>
                      <option value="score">By Score</option>
                      <option value="newest">Newest First</option>
                      <option value="oldest">Oldest First</option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      This will be used when the app starts
                    </p>
                  </div>
                </div>
              </div>

                {/* Credentials */}
              <div className="border-t border-gray-700 pt-4 mt-4">
                <h3 className="text-lg font-semibold mb-2">e621</h3>

                <div className="text-xs text-gray-400 mb-2">
                  Used for Feeds, Favoriting, and Sync.
                </div>

                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="Username"
                    value={apiUsername}
                    onChange={(e) => setApiUsername(e.target.value)}
                    className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
                  />
                  <input
                    type="password"
                    placeholder={e621CredInfo.has_api_key ? "API Key (saved) — leave blank to keep" : "API Key"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="flex gap-2 items-center">
                  <button
                    onClick={saveE621Credentials}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded"
                  >
                    Save
                  </button>

                  <button
                    onClick={testE621Credentials}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded"
                  >
                    Test connection
                  </button>

                  <div className="text-xs text-gray-400">
                    Key: {e621CredInfo.has_api_key ? "saved" : "not set"}
                  </div>
                </div>

                <p className="text-xs text-gray-500 mt-2">
                  Get your API key from e621.net account settings. The app stores it locally.
                </p>
              </div>
                {/* Parcing */}
              <div className="border-t border-gray-700 pt-4 mt-4">
                <h3 className="text-lg font-semibold mb-2">Sync Favorites</h3>

                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    placeholder="Stop after N new downloads (blank = unlimited)"
                    value={syncMaxNew}
                    onChange={(e) => setSyncMaxNew(e.target.value)}
                    className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
                  />

                  <button
                    onClick={startSync}
                    disabled={!!syncStatus?.running}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50"
                  >
                    {syncStatus?.running ? "Running..." : "Start"}
                  </button>

                  <button
                    onClick={cancelSync}
                    disabled={!syncStatus?.running}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>

                {syncStatus && (
                  <div className="mt-3 text-sm text-gray-300 space-y-1">
                    <div>Pages scanned: {syncStatus.scanned_pages}</div>
                    <div>Posts scanned: {syncStatus.scanned_posts}</div>
                    <div>Skipped (already in DB): {syncStatus.skipped_existing}</div>
                    <div>New attempted: {syncStatus.new_attempted}</div>
                    <div>Downloaded OK: {syncStatus.downloaded_ok}</div>
                    <div>Failed downloads: {syncStatus.failed_downloads}</div>
                    <div>Unavailable (no file URL): {syncStatus.unavailable}</div>

                    {syncStatus.last_error && (
                      <div className="text-red-300 break-words">Last error: {syncStatus.last_error}</div>
                    )}

                    <button
                      onClick={loadUnavailable}
                      className="mt-2 px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm"
                    >
                      View unavailable list
                    </button>
                  </div>
                )}
              </div>
              {showUnavailable && (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                  <div className="absolute inset-0 bg-black/60" onClick={() => setShowUnavailable(false)} />
                  <div className="relative z-10 w-full max-w-3xl bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-lg font-semibold">Unavailable favorites</h2>
                      <button onClick={() => setShowUnavailable(false)} className="text-gray-400 hover:text-gray-200">
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    <div className="max-h-[60vh] overflow-y-auto space-y-3">
                      {unavailableList.length === 0 ? (
                        <div className="text-gray-400">No unavailable posts recorded.</div>
                      ) : (
                        unavailableList.map((u) => (
                          <div key={`${u.source}:${u.source_id}`} className="bg-gray-900 border border-gray-700 rounded p-3">
                            <div className="text-sm text-gray-200">
                              <span className="text-gray-400">{u.source}</span> #{u.source_id}
                              <span className="text-gray-500"> • {u.reason}</span>
                              <span className="text-gray-500"> • {u.seen_at}</span>
                            </div>

                            <div className="mt-2 text-xs text-gray-300 space-y-1">
                              {u.sources.length > 0 ? (
                                u.sources.map((s, i) => (
                                  <div key={i}>
                                    <button
                                      onClick={() => openExternalUrl(s)}
                                      className="text-purple-400 underline break-all cursor-pointer bg-transparent border-none p-0 text-left"
                                    >
                                      {s}
                                    </button>
                                  </div>
                                ))
                              ) : (
                                <div className="text-gray-500">No source links available.</div>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>
        )}
      </div>

      {/* Viewer Tab */}
      {activeTab === 'viewer' && (
        <>
          <div className="border-b border-gray-700 p-4">
            <div className="max-w-7xl mx-auto">
              <div className="flex gap-4 items-center flex-wrap">
                <div className="flex-1 min-w-[200px] relative">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search tags..."
                    value={searchTags}
                    onChange={(e) => setSearchTags(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500"
                  />
                </div>

                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  className="px-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500"
                >
                  <option value="default">Default Order</option>
                  <option value="random">Random</option>
                  <option value="score">By Score</option>
                  <option value="newest">Newest First</option>
                  <option value="oldest">Oldest First</option>
                </select>

                <div className="text-gray-400">
                  {filteredItems.length} / {items.length} items
                </div>
              </div>

              {selectedTags.length > 0 && (
                <div className="mt-3 flex gap-2 flex-wrap">
                  {selectedTags.map(tag => (
                    <button
                      key={tag}
                      onClick={() => toggleTag(tag)}
                      className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded-full text-sm flex items-center gap-1"
                    >
                      {tag}
                      <X className="w-3 h-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {filteredItems.length > 0 ? (
            <div className="max-w-7xl mx-auto p-4">
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                <div className="lg:col-span-3">
                  <div
                    className={
                      viewerOverlay
                        ? "fixed inset-0 z-50 bg-black"
                        : "bg-gray-800 rounded-lg overflow-hidden"
                    }
                    onMouseMove={() => viewerOverlay && pokeHud()}
                    onMouseDown={() => viewerOverlay && pokeHud()}
                    onWheel={() => viewerOverlay && pokeHud()}
                    onTouchStart={() => viewerOverlay && pokeHud()}
                  >
                    {currentItem && (
                      <div className={viewerOverlay ? "relative w-full h-full" : "relative bg-black"}>
                        {imageLoading && (
                          <div className="absolute inset-0 flex items-center justify-center z-10">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
                          </div>
                        )}
                        {viewerOverlay && (
                          <>
                            {/* Left click zone → previous */}
                            <div
                              className="absolute inset-y-0 left-0 w-1/2 z-0 cursor-pointer"
                              onClick={() => goToPrev(true)}
                            />

                            {/* Right click zone → next */}
                            <div
                              className="absolute inset-y-0 right-0 w-1/2 z-0 cursor-pointer"
                              onClick={() => goToNext(true)}
                            />
                          </>
                        )}

                        {/* Media area */}
                        <div className={viewerOverlay ? "w-full h-full flex items-center justify-center bg-black" : "bg-black"}>
                          {isVideo ? (
                            <video
                              key={currentItem.url}
                              src={currentItem.url}
                              controls
                              autoPlay
                              loop={!waitForVideoEnd || !isSlideshow}
                              muted={autoMuteVideos}
                              className={
                                viewerOverlay
                                  ? `w-full h-full object-contain transition-opacity duration-300 ${fadeIn ? "opacity-100" : "opacity-0"}`
                                  : `w-full h-auto max-h-[70vh] object-contain transition-opacity duration-300 ${fadeIn ? "opacity-100" : "opacity-0"}`
                              }
                              style={viewerOverlay ? { pointerEvents: 'none' } : undefined}
                              onLoadedData={(e) => {
                                const video = e.currentTarget as HTMLVideoElement;
                                if (!autoMuteVideos) {
                                  video.volume = 1.0;
                                }
                                setImageLoading(false);
                              }}
                              onLoadStart={() => setImageLoading(true)}
                              onError={() => {
                                setImageLoading(false);
                                console.error("Video load error");
                              }}
                              onEnded={() => {
                                // Auto-advance when video ends (if enabled and slideshow is active)
                                if (waitForVideoEnd && isSlideshow) {
                                  goToNext();
                                }
                              }}
                            />
                          ) : (
                            <img
                              src={currentItem.url}
                              alt="Favorite"
                              className={
                                viewerOverlay
                                  ? `w-full h-full object-contain transition-opacity duration-300 ${fadeIn ? "opacity-100" : "opacity-0"}`
                                  : `w-full h-auto max-h-[70vh] object-contain transition-opacity duration-300 ${fadeIn ? "opacity-100" : "opacity-0"}`
                              }
                              onLoad={() => setImageLoading(false)}
                              onLoadStart={() => setImageLoading(true)}
                              onError={(e) => {
                                setImageLoading(false);
                                const img = e.currentTarget as HTMLImageElement;
                                img.src =
                                  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%23374151' width='400' height='300'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='%239CA3AF' font-size='20'%3EImage not found%3C/text%3E%3C/svg%3E";
                              }}
                            />
                          )}
                        </div>

                        {/* Controls  */}
                        <div
                          className={
                            viewerOverlay
                              ? [
                                  "absolute bottom-6 left-1/2 -translate-x-1/2", //
                                  "transition-all duration-300 ease-out",
                                  showHud ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none",
                                ].join(" ")
                              : "p-4 bg-gray-800 border-t border-gray-700"
                          }
                          onMouseEnter={() => {
                            if (!viewerOverlay) return;
                            hudHoverRef.current = true;
                            setShowHud(true);
                          }}
                          onMouseLeave={() => {
                            if (!viewerOverlay) return;
                            hudHoverRef.current = false;
                            scheduleHudHide();
                          }}
                        >
                            <div
                              className={
                                viewerOverlay
                                  ? "relative z-20 px-6 py-4 bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-700/50 shadow-2xl"
                                  : ""
                              }
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="flex items-center justify-between mb-4">
                                {!viewerOverlay && (
                                  <button onClick={() => goToPrev(true)} className="p-2 bg-gray-700 hover:bg-gray-600 rounded">
                                    <ChevronLeft className="w-5 h-5" />
                                  </button>
                                )}

                                <div className="flex gap-2 items-center">
                                  <button
                                    onClick={() => setIsSlideshow(!isSlideshow)}
                                    className="p-2 bg-purple-600 hover:bg-purple-700 rounded"
                                  >
                                    {isSlideshow ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                                  </button>

                                  <select
                                    value={slideshowSpeed}
                                    onChange={(e) => setSlideshowSpeed(Number(e.target.value))}
                                    className="px-3 py-2 bg-gray-700 border border-gray-600 rounded"
                                  >
                                    <option value={1000}>1s</option>
                                    <option value={3000}>3s</option>
                                    <option value={5000}>5s</option>
                                    <option value={10000}>10s</option>
                                  </select>

                                  <button
                                    onClick={() => setAutoMuteVideos(!autoMuteVideos)}
                                    className={`p-2 rounded ${
                                      autoMuteVideos 
                                        ? 'bg-purple-600 hover:bg-purple-700' 
                                        : 'bg-gray-700 hover:bg-gray-600'
                                    }`}
                                    title="Mute all videos"
                                  >
                                    {autoMuteVideos ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                                  </button>

                                  <button
                                    onClick={() => setWaitForVideoEnd(!waitForVideoEnd)}
                                    className={`p-2 rounded ${
                                      waitForVideoEnd 
                                        ? 'bg-purple-600 hover:bg-purple-700' 
                                        : 'bg-gray-700 hover:bg-gray-600'
                                    }`}
                                    title="Wait for videos to finish before advancing"
                                  >
                                    <Clock className="w-5 h-5" />
                                  </button>

                                  {/* This button now toggles overlay mode */}
                                  <button
                                    onClick={() => {setViewerOverlay((v) => !v);toggleFullscreen();}}
                                    className="p-2 bg-gray-700 hover:bg-gray-600 rounded"
                                    title={viewerOverlay ? "Exit full viewer" : "Full viewer"}
                                  >
                                    <Maximize className="w-5 h-5" />
                                  </button>

                                  {!viewerOverlay && (
                                    <button 
                                      onClick={deleteCurrentItem} 
                                      className="p-2 bg-gray-700 hover:bg-red-600 rounded text-gray-400 hover:text-white transition-colors"
                                      title="Move to trash"
                                    >
                                      <Trash2 className="w-5 h-5" />
                                    </button>
                                  )}
                                </div>
                                {!viewerOverlay && (
                                  <button onClick={() => goToNext(true)} className="p-2 bg-gray-700 hover:bg-gray-600 rounded">
                                    <ChevronRight className="w-5 h-5" />
                                  </button>
                                )}
                              </div>

                          {!viewerOverlay && (
                            <div className="text-center text-gray-400 text-sm">
                              {currentIndex + 1} / {filteredItems.length}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    )}
                  </div>

                  {currentItem && (
                    <div className="mt-4 bg-gray-800 rounded-lg p-4">
                      <div className="text-sm text-gray-400 mb-2">
                        <button
                          onClick={() => openExternalUrl(`https://e621.net/posts/${currentItem.id}`)}
                          className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0"
                        >
                          e621
                        </button>
                        {currentItem.sources && currentItem.sources.length > 0 && (
                          <>
                            {currentItem.sources.slice(0, 3).map((source, i) => (
                              <span key={i}>
                                {' • '}
                                <button
                                  onClick={() => openExternalUrl(source)}
                                  className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0"
                                  title={source}
                                >
                                  {getSocialMediaName(source)}
                                </button>
                              </span>
                            ))}
                          </>
                        )}
                        {currentItem.artist && currentItem.artist.length > 0 && (
                          <>
                            {' • Artist: '}
                            {currentItem.artist.map((artist, i) => (
                              <span key={i}>
                                {i > 0 && ', '}
                                <button
                                  onClick={() => openExternalUrl(`https://e621.net/posts?tags=${artist}`)}
                                  className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0"
                                >
                                  {artist}
                                </button>
                              </span>
                            ))}
                          </>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {currentItem.tags?.slice(0, 20).map((tag, i) => (
                          <button
                            key={i}
                            onClick={() => toggleTag(tag)}
                            className={`px-2 py-1 rounded text-xs ${
                              selectedTags.includes(tag)
                                ? 'bg-purple-600'
                                : 'bg-gray-700 hover:bg-gray-600'
                            }`}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="lg:col-span-1">
                  <div className="bg-gray-800 rounded-lg p-4">
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <Tag className="w-4 h-4" />
                      Popular Tags
                    </h3>
                    <div className="max-h-[70vh] overflow-y-auto space-y-1">
                      {allTags.slice(0, 50).map(tag => {
                        const count = items.filter(item => item.tags?.includes(tag)).length;
                        return (
                          <button
                            key={tag}
                            onClick={() => toggleTag(tag)}
                            className={`w-full text-left px-2 py-1 rounded text-sm hover:bg-gray-700 ${
                              selectedTags.includes(tag) ? 'bg-purple-600' : ''
                            }`}
                          >
                            {tag} <span className="text-gray-500">({count})</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-20 text-gray-400">
              <Upload className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p className="text-xl">No items yet</p>
              <p className="text-sm mt-2">Open Settings → e621 → Sync Favorites to download your library</p>
            </div>
          )}
        </>
      )}

      {/* Feeds Tab */}
      {activeTab === 'feeds' && (
        <div className="max-w-7xl mx-auto p-4">
          {/* Add Feed */}
          <div className="bg-gray-800 rounded-lg p-4 mb-6">
            <h3 className="text-lg font-semibold mb-3">Add New Feed</h3>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Feed name (optional)"
                value={newFeedName}
                onChange={(e) => setNewFeedName(e.target.value)}
                className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
              />
              <input
                type="text"
                placeholder="e621 search query (e.g. rating:s score:>200)"
                value={newFeedQuery}
                onChange={(e) => setNewFeedQuery(e.target.value)}
                className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
              />
              <button
                onClick={addFeed}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>
          </div>

          {/* Feed List */}
          {feeds.map(feed => (
            <div key={feed.id} className="bg-gray-800 rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-lg font-semibold">{feed.name}</h3>
                  <p className="text-sm text-gray-400">{feed.query}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => fetchFeedPosts(feed.id, feed.query, { reset: true })}
                    disabled={loadingFeeds[feed.id]}
                    className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded text-sm disabled:opacity-50"
                  >
                    {loadingFeeds[feed.id] ? 'Loading...' : 'Load'}
                  </button>
                  <button
                    onClick={() => removeFeed(feed.id)}
                    className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-sm"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Pinterest-style Masonry Grid */}
              {feedPosts[feed.id] && feedPosts[feed.id].length > 0 && (
                <Masonry
                  breakpointCols={feedBreakpoints}
                  className="flex w-auto gap-3"
                  columnClassName="flex flex-col gap-3"
                >
                  {feedPosts[feed.id].map((post) => {
                    const busy = !!feedActionBusy[post.id];
                    const isRemoteFav = !!post.is_favorited;
                    const imageUrl = post.sample?.url || post.file?.url || post.preview?.url;
                    const sourceUrl = `https://e621.net/posts/${post.id}`;
                    const artists = post.tags?.artist || [];

                    // (optional) reserve space to reduce layout shift while loading
                    const w = post.sample?.width || post.file?.width || 1;
                    const h = post.sample?.height || post.file?.height || 1;

                    return (
                      <div
                        key={post.id}
                        className="relative group bg-gray-700 rounded overflow-hidden"
                      >
                        {downloadedE621Ids.has(post.id) && (
                          <div className="absolute top-2 left-2 z-20 bg-gray-900/70 text-gray-200 px-2 py-1 rounded flex items-center gap-1">
                            <Database className="w-4 h-4" />
                          </div>
                        )}
                        {imageUrl ? (
                          <>
                            <img
                              src={imageUrl}
                              alt=""
                              className="w-full object-cover rounded"
                              style={{ aspectRatio: `${w} / ${h}` }}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                            <button
                              onClick={() => ensureFavorite(feed.id, post)}
                              disabled={busy}
                              className={`absolute top-2 right-2 p-2 rounded-full transition z-20 ${
                                isRemoteFav
                                  ? "bg-yellow-500 text-yellow-900"
                                  : "bg-gray-900/70 text-gray-300 hover:bg-gray-900/90"
                              } ${busy ? "opacity-60 cursor-not-allowed" : ""}`}
                            >
                              {busy ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                              ) : (
                                <Star className={`w-5 h-5 ${isRemoteFav ? "fill-current" : ""}`} />
                              )}
                            </button>

                            <div
                              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center gap-2 z-10"
                              style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
                            >
                              <p className="text-xs text-white">
                                Score: {post.score?.total || 0} | ❤️ {post.fav_count || 0}
                              </p>
                              {artists.length > 0 && (
                                <p className="text-xs text-gray-300">
                                  {artists.slice(0, 2).join(", ")}
                                </p>
                              )}
                              <button
                                onClick={() => openExternalUrl(sourceUrl)}
                                className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded text-xs text-white"
                              >
                                View Source
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="w-full h-48 flex items-center justify-center bg-gray-800">
                            <p className="text-gray-500 text-sm">No image</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Masonry>
              )}
              <InfiniteSentinel
                disabled={
                  !e621CredInfo.username ||
                  !e621CredInfo.has_api_key ||
                  !!loadingFeeds[feed.id] ||
                  !!feedPaging[feed.id]?.done
                }
                onVisible={() => fetchFeedPosts(feed.id, feed.query)}
              />

              {feedPaging[feed.id]?.done && (
                <div className="text-center text-gray-500 text-sm py-4">
                  End of results
                </div>
              )}
            </div>
          ))}
          {feeds.length === 0 && (
            <div className="text-center py-20 text-gray-400">
              <Rss className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p className="text-xl">No feeds yet</p>
              <p className="text-sm mt-2">Add your first e621 search query above</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}