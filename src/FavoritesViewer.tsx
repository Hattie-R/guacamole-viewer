import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Search, Upload, Play, Pause, ChevronLeft, ChevronRight,
  X, Tag, Trash2, Rss, Plus, Star, Maximize, Settings,
  Database, Loader2, Volume2, VolumeX, Clock, Pencil, RefreshCw
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import Masonry from "react-masonry-css";

// --- TYPE DEFINITIONS ---
type AppConfig = { library_root?: string | null };
type ItemDto = { item_id: number; source: string; source_id: string; remote_url?: string | null; file_abs: string; ext?: string | null; tags: string[]; artists: string[]; sources: string[]; rating?: string | null; fav_count?: number | null; score_total?: number | null; timestamp?: string | null; added_at: string; };
type LibraryItem = { id?: number; item_id: number; source: string; source_id: string; remote_url?: string | null; url: string; ext?: string | null; tags: string[]; artist: string[]; sources: string[]; rating?: string | null; fav_count?: number | null; score?: { total: number }; timestamp?: string | null; };
type SyncStatus = { running: boolean; cancelled: boolean; max_new_downloads?: number | null; scanned_pages: number; scanned_posts: number; skipped_existing: number; new_attempted: number; downloaded_ok: number; failed_downloads: number; unavailable: number; last_error?: string | null; };
type UnavailableDto = { source: string; source_id: string; seen_at: string; reason: string; sources: string[]; };
type Feed = { id: number; name: string; query: string };
type FeedPagingState = { beforeId: number | null; done: boolean };
type E621CredInfo = { username?: string | null; has_api_key: boolean };
type FASyncStatus = { running: boolean; scanned: number; skipped_url: number; skipped_md5: number; imported: number; upgraded: number; errors: number; current_message: string;};
type FACreds = { a: string; b: string };


// --- THE COMPONENT ---
export default function FavoritesViewer() {
  // --- STATE AND REFS ---
  const [activeTab, setActiveTab] = useState('viewer');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [searchTags, setSearchTags] = useState('');
  const [sortOrder, setSortOrder] = useState(() => localStorage.getItem('preferred_sort_order') || 'default');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [fadeIn, setFadeIn] = useState(true);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageCache, setImageCache] = useState<Record<string, boolean>>({});

  // Slideshow
  const [isSlideshow, setIsSlideshow] = useState(false);
  const [slideshowSpeed, setSlideshowSpeed] = useState(3000);
  const [autoMuteVideos, setAutoMuteVideos] = useState(true);
  const [waitForVideoEnd, setWaitForVideoEnd] = useState(false);
  
  // Feeds
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedPosts, setFeedPosts] = useState<Record<number, any[]>>({});
  const [loadingFeeds, setLoadingFeeds] = useState<Record<number, boolean>>({});
  const [newFeedQuery, setNewFeedQuery] = useState('');
  const [newFeedName, setNewFeedName] = useState('');
  const [selectedFeedId, setSelectedFeedId] = useState<number | null>(null);
  const [showAddFeedModal, setShowAddFeedModal] = useState(false);
  const [editingFeedId, setEditingFeedId] = useState<number | null>(null);

  // Settings & System
  const [showSettings, setShowSettings] = useState(false);
  const [libraryRoot, setLibraryRoot] = useState("");
  const [syncMaxNew, setSyncMaxNew] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [unavailableList, setUnavailableList] = useState<UnavailableDto[]>([]);
  
  // Paging & Loading
  const [initialLoading, setInitialLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreItems, setHasMoreItems] = useState(true);
  const [totalDatabaseItems, setTotalDatabaseItems] = useState(0);
  const [itemsPerPage, setItemsPerPage] = useState(() => Number(localStorage.getItem('items_per_page') || 100));
  const loadingRef = useRef(false);

  // e621
  const [downloadedE621Ids, setDownloadedE621Ids] = useState<Set<number>>(new Set());
  const [feedActionBusy, setFeedActionBusy] = useState<Record<number, boolean>>({});
  const [feedPaging, setFeedPaging] = useState<Record<number, FeedPagingState>>({}); 
  const [apiUsername, setApiUsername] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [e621CredInfo, setE621CredInfo] = useState<E621CredInfo>({ username: null, has_api_key: false });
  const [credWarned, setCredWarned] = useState(false);

  // UI
  const [viewerOverlay, setViewerOverlay] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const syncWasRunningRef = useRef(false);
  const hudHoverRef = useRef(false);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const HUD_TIMEOUT_MS = 2000;
  const feedBreakpoints = { default: 3, 1024: 3, 768: 2, 520: 1 };

  // Other
  const [showTagModal, setShowTagModal] = useState(false);
  const [editingTags, setEditingTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");
  const [filterRating, setFilterRating] = useState('all');

  // FurAffinity
  const [faCreds, setFaCreds] = useState<FACreds>({ a: '', b: '' });
  const [faStatus, setFaStatus] = useState<FASyncStatus | null>(null);
  const [filterSource, setFilterSource] = useState('all'); // for filtering view

  // --- DERIVED STATE (useMemo) ---
  const filteredItems = useMemo(() => {
    let filtered = items;
    if (filterSource !== 'all') {
      filtered = filtered.filter(item => item.source === filterSource);
    }
    if (filterRating !== 'all') {
      if (filterRating === 's') {
        filtered = filtered.filter(item => item.rating === 's');
      } else if (filterRating === 'q') {
        filtered = filtered.filter(item => item.rating === 'q');
      } else if (filterRating === 'e') {
        filtered = filtered.filter(item => item.rating === 'e');
      } else if (filterRating === 'nsfw') {
        // Includes both Questionable and Explicit
        filtered = filtered.filter(item => item.rating === 'q' || item.rating === 'e');
      }
    }
    if (searchTags.trim()) {
      const searchTerms = searchTags.toLowerCase().split(' ').filter(t => t);
      filtered = filtered.filter(item => searchTerms.every(term => item.tags?.some(tag => tag.toLowerCase().includes(term))));
    }
    if (selectedTags.length > 0) {
      filtered = filtered.filter(item => selectedTags.every(tag => item.tags?.includes(tag)));
    }
    if (sortOrder === 'random') return [...filtered].sort(() => Math.random() - 0.5);
    if (sortOrder === 'score') return [...filtered].sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0));
    if (sortOrder === 'newest') return [...filtered].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    if (sortOrder === 'oldest') return [...filtered].sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
    return filtered;
  }, [items, searchTags, selectedTags, sortOrder, filterSource, filterRating]);

  const currentItem = filteredItems[currentIndex];
  const ext = (currentItem?.ext || "").toLowerCase();
  const isVideo = ext === "mp4" || ext === "webm";

  // --- CORE DATA FUNCTIONS ---
  const loadData = async (append = false) => {
    try {
      const offset = append ? items.length : 0;
      const rows = await invoke<ItemDto[]>("list_items", { limit: itemsPerPage, offset });
      if (!append) {
        const total = await invoke<number>("get_library_stats");
        setTotalDatabaseItems(total);
      }
      setHasMoreItems(rows.length === itemsPerPage);
      
      const mapped = rows.map((r): LibraryItem => ({
        ...r,
        url: convertFileSrc(r.file_abs),
        id: Number(r.source_id),
        artist: r.artists || [],
        tags: r.tags || [],
        sources: r.sources || [],
        score: { total: r.score_total ?? 0 },
      }));

      setItems(prev => append ? [...prev, ...mapped] : mapped);
    } catch (error) {
      console.error("Failed to load library:", error);
      alert("Failed to load library. Please check your library settings.");
    }
  };

  const loadMoreItems = async () => {
    if (loadingRef.current || !hasMoreItems) return;
    loadingRef.current = true;
    setIsLoadingMore(true);
    try {
      await loadData(true);
    } finally {
      setIsLoadingMore(false);
      loadingRef.current = false;
    }
  };

  // --- HELPER FUNCTIONS ---
  const scheduleHudHide = useCallback(() => {
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => { if (!hudHoverRef.current) setShowHud(false); }, HUD_TIMEOUT_MS);
  }, []);

  const pokeHud = useCallback(() => {
    setShowHud(true);
    scheduleHudHide();
  }, [scheduleHudHide]);

  const goToNext = useCallback((manual = false) => {
    if (viewerOverlay && manual) pokeHud();
    setFadeIn(false);
    setTimeout(() => { setCurrentIndex((prev) => (prev + 1) % filteredItems.length); setFadeIn(true); }, 150);
  }, [viewerOverlay, pokeHud, filteredItems.length]);

  const goToPrev = useCallback((manual = false) => {
    if (viewerOverlay && manual) pokeHud();
    setFadeIn(false);
    setTimeout(() => { setCurrentIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length); setFadeIn(true); }, 150);
  }, [viewerOverlay, pokeHud, filteredItems.length]);

  const refreshSyncStatus = async () => { setSyncStatus(await invoke<SyncStatus>("e621_sync_status")); };
  const startSync = async () => {
    const n = syncMaxNew.trim() === "" ? null : Number(syncMaxNew);
    if (syncMaxNew.trim() !== "" && (!Number.isFinite(n) || n! <= 0)) { alert("Stop-after-N must be a positive number or blank."); return; }
    await invoke("e621_sync_start", { maxNewDownloads: n });
    syncWasRunningRef.current = true;
    await refreshSyncStatus();
  };
  const cancelSync = async () => { await invoke("e621_sync_cancel"); await refreshSyncStatus(); };
  const loadUnavailable = async () => { setUnavailableList(await invoke<UnavailableDto[]>("e621_unavailable_list", { limit: 200 })); setShowUnavailable(true); };
  const refreshE621CredInfo = async () => {
    const info = await invoke<E621CredInfo>("e621_get_cred_info");
    setE621CredInfo(info);
    if (info.username) setApiUsername(info.username);
  };
  const saveE621Credentials = async () => {
    await invoke("e621_set_credentials", { username: apiUsername, apiKey: apiKey });
    setApiKey("");
    await refreshE621CredInfo();
    alert("Saved e621 credentials.");
  };
  const testE621Credentials = async () => { alert((await invoke<{ ok: boolean; message: string }>("e621_test_connection")).message); };
  const favoriteOnE621 = async (postId: number) => { await invoke("e621_favorite", { postId }); };
  const ensureFavorite = async (feedId: number, post: any) => {
    const id = post.id as number;
    try {
      setFeedActionBusy((prev) => ({ ...prev, [id]: true }));
      if (!downloadedE621Ids.has(id)) {
        if (!post?.file?.url) throw new Error("This post has no original file URL (deleted/blocked).");
        await invoke("add_e621_post", { post: { id: post.id, file_url: post.file.url, file_ext: post.file.ext, file_md5: post.file.md5, rating: post.rating, fav_count: post.fav_count, score_total: post.score?.total, created_at: post.created_at, sources: post.sources || [], tags: { general: post.tags?.general || [], species: post.tags?.species || [], character: post.tags?.character || [], artist: post.tags?.artist || [], meta: post.tags?.meta || [], lore: post.tags?.lore || [], copyright: post.tags?.copyright || [] } } });
        await loadData();
      }
      await favoriteOnE621(id);
      setFeedPosts((prev) => ({ ...prev, [feedId]: (prev[feedId] || []).map((p: any) => p.id === id ? { ...p, is_favorited: true } : p) }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(msg);
    } finally {
      setFeedActionBusy((prev) => ({ ...prev, [id]: false }));
    }
  };
  const refreshLibraryRoot = async () => { const cfg = await invoke<AppConfig>("get_config"); setLibraryRoot(cfg.library_root || ""); };
  const changeLibraryRoot = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;
    await invoke("set_library_root", { libraryRoot: dir });
    await refreshLibraryRoot();
    await loadData();
  };
  const toggleFullscreen = () => { if (viewerOverlay) pokeHud(); if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); };
  const openExternalUrl = async (url: string) => { try { await openUrl(url); } catch (e) { console.error("Failed to open URL:", e); alert("Failed to open link."); } };
  const handlePageSizeChange = async (newSize: number) => {
    setItemsPerPage(newSize);
    localStorage.setItem('items_per_page', String(newSize));
    setInitialLoading(true);
    try { await loadData(false); } finally { setInitialLoading(false); }
  };
  const getSocialMediaName = (url: string): string => {
    try {
      const urlLower = url.toLowerCase();
      if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) return 'Twitter/X';
      if (urlLower.includes('furaffinity.net')) return 'FurAffinity';
      const hostname = new URL(url).hostname.replace('www.', '');
      const domain = hostname.split('.')[0];
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    } catch { return 'Source'; }
  };
  const loadFeeds = () => { try { const stored = localStorage.getItem('e621_feeds'); if (stored) setFeeds(JSON.parse(stored)); } catch {} };
  const saveFeeds = (newFeeds: Feed[]) => { localStorage.setItem("e621_feeds", JSON.stringify(newFeeds)); setFeeds(newFeeds); };
  const removeFeed = (feedId: number) => { saveFeeds(feeds.filter((f) => f.id !== feedId)); setFeedPosts((prev) => { const copy = { ...prev }; delete copy[feedId]; return copy; }); };
  const fetchFeedPosts = async (feedId: number, query: string, { reset = false }: { reset?: boolean } = {}) => {
    if (!e621CredInfo.username || !e621CredInfo.has_api_key) { if (!credWarned) { alert("Set e621 credentials in Settings first."); setCredWarned(true); } return; }
    if (loadingFeeds[feedId] || (!reset && (feedPaging[feedId]?.done || /\border:random\b/i.test(query)))) return;
    setLoadingFeeds(prev => ({ ...prev, [feedId]: true }));
    try {
      const LIMIT = 50;
      const pageParam = (reset ? null : feedPaging[feedId]?.beforeId) ? `b${feedPaging[feedId]?.beforeId}` : "1";
      const data = await invoke<any>("e621_fetch_posts", { tags: query, limit: LIMIT, page: pageParam });
      const newPosts = data.posts || [];
      setFeedPosts(prev => { const existing = reset ? [] : (prev[feedId] || []); const uniqueMap = new Map(); [...existing, ...newPosts].forEach(p => uniqueMap.set(p.id, p)); return { ...prev, [feedId]: Array.from(uniqueMap.values()) }; });
      const minId = newPosts.reduce((m: number, p: any) => Math.min(m, p.id), Number.POSITIVE_INFINITY);
      setFeedPaging(prev => ({ ...prev, [feedId]: { beforeId: (minId !== Number.POSITIVE_INFINITY) ? minId : feedPaging[feedId]?.beforeId, done: newPosts.length < LIMIT } }));
    } catch (e) { console.error('Error fetching feed:', e); alert("Error fetching feed: " + (e instanceof Error ? e.message : String(e))); } 
    finally { setLoadingFeeds(prev => ({ ...prev, [feedId]: false })); }
  };
  const toggleTag = (tag: string) => setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  const deleteCurrentItem = async () => { if (!currentItem) return; await invoke("trash_item", { itemId: currentItem.item_id }); await loadData(); };
  const saveTags = async () => {
    if (!currentItem) return;
    
    try {
      await invoke("update_item_tags", { 
        itemId: currentItem.item_id, 
        tags: editingTags 
      });

      // Update local state immediately so UI reflects changes
      setItems(prev => prev.map(item => 
        item.item_id === currentItem.item_id 
          ? { ...item, tags: editingTags } 
          : item
      ));

      setShowTagModal(false);
    } catch (error) {
      console.error("Failed to update tags:", error);
      alert("Failed to save tags: " + String(error));
    }
  };

  const startFaSync = async () => {
    if (!faCreds.a || !faCreds.b) {
      alert("Please set Cookie A and Cookie B first.");
      return;
    }
    await invoke("fa_set_credentials", { a: faCreds.a, b: faCreds.b });
    await invoke("fa_start_sync");
    
    // Start polling
    const interval = setInterval(async () => {
      const st = await invoke<FASyncStatus>("fa_sync_status");
      setFaStatus(st);
      if (!st.running) {
        clearInterval(interval);
        loadData(); // Reload library when done
      }
    }, 1000);
  };

  const cancelFaSync = async () => {
    await invoke("fa_cancel_sync");
  };

  // --- EFFECTS ---
  // Build allTags whenever items change
  useEffect(() => {
    const tagCounts = new Map<string, number>();
    items.forEach(item => {
      item.tags?.forEach(tag => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    });
    
    // Sort by count (most popular first)
    const sorted = Array.from(tagCounts.entries())
      .sort(([, countA], [, countB]) => countB - countA)
      .map(([tag]) => tag);
    
    setAllTags(sorted);
  }, [items]);

  useEffect(() => {
    const init = async () => {
      setInitialLoading(true);
      try {
        await loadData();
        await refreshLibraryRoot();
        loadFeeds();
        await refreshE621CredInfo();
      } catch (error) { console.error("Failed to initialize:", error); } 
      finally { setInitialLoading(false); }
    };
    init();
  }, []);

  useEffect(() => {
    if (!showSettings) return;
    let t: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      try {
        const st = await invoke<SyncStatus>("e621_sync_status");
        setSyncStatus(st);
        if (syncWasRunningRef.current && !st.running) { await loadData(); }
        syncWasRunningRef.current = st.running;
      } catch {}
    };
    tick();
    t = setInterval(tick, 1000);
    return () => { if (t) clearInterval(t); };
  }, [showSettings]);
  
    // Global keyboard navigation & shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 1. Ignore if typing in an input
      const target = e.target as HTMLElement | null;
      const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (isTyping) return;

      const key = e.key.toLowerCase();

      // 2. Global Shortcuts
      if (e.key === "Escape") {
        e.preventDefault();
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        if (showTagModal) {
          setShowTagModal(false);
          return;
        }
        if (viewerOverlay) {
          pokeHud();
          if (document.fullscreenElement) document.exitFullscreen();
          setViewerOverlay(false);
        }
      }

      // S = Settings
      if (key === "s") {
        e.preventDefault();
        setShowSettings(prev => !prev);
      }

      // 3. Viewer Specific Shortcuts
      if (activeTab === "viewer") {
        // Navigation
        if (key === "a" || e.key === "ArrowLeft") { 
          e.preventDefault(); 
          goToPrev(true); 
        } 
        else if (key === "d" || e.key === "ArrowRight") { 
          e.preventDefault(); 
          goToNext(true); 
        }
        
        // F = Fullscreen
        else if (key === "f") {
          e.preventDefault();
          setViewerOverlay(v => !v);
          toggleFullscreen();
        }
        
        // M = Mute
        else if (key === "m") {
          e.preventDefault();
          setAutoMuteVideos(v => !v);
        }
        
        // V = Wait for Video
        else if (key === "v") {
          e.preventDefault();
          setWaitForVideoEnd(v => !v);
        }

        // E = Edit Tags
        else if (key === "e") {
          e.preventDefault();
          if (currentItem) {
            setEditingTags([...(currentItem.tags || [])]);
            setNewTagInput("");
            setShowTagModal(true);
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, viewerOverlay, pokeHud, goToPrev, goToNext, currentItem, showSettings, showTagModal]);
  
  useEffect(() => { if (viewerOverlay) pokeHud(); }, [viewerOverlay, pokeHud]);
  useEffect(() => { return () => { if (hudTimerRef.current) clearTimeout(hudTimerRef.current); }; }, []);
  useEffect(() => {
    const handleFullscreenChange = () => { if (!document.fullscreenElement && viewerOverlay) setViewerOverlay(false); };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [viewerOverlay]);
  useEffect(() => { setCurrentIndex(0); }, [filteredItems]);
  useEffect(() => { try { localStorage.setItem('preferred_sort_order', sortOrder); } catch {} }, [sortOrder]);
  useEffect(() => { setDownloadedE621Ids(new Set(items.filter(it => it.source === "e621").map(it => Number(it.source_id)))); }, [items]);
  useEffect(() => {
    if (!isSlideshow || filteredItems.length === 0) return;
    const isCurrentVideo = currentItem && ["mp4", "webm"].includes((currentItem.ext || "").toLowerCase());
    if (waitForVideoEnd && isCurrentVideo) return;
    const interval = setInterval(() => { goToNext(); }, slideshowSpeed);
    return () => clearInterval(interval);
  }, [isSlideshow, slideshowSpeed, filteredItems.length, currentIndex, waitForVideoEnd, goToNext]);
  
  useEffect(() => {
    if (filteredItems.length === 0) return;
    const preloadIndexes = [currentIndex, (currentIndex + 1) % filteredItems.length, (currentIndex + 2) % filteredItems.length, (currentIndex - 1 + filteredItems.length) % filteredItems.length];
    preloadIndexes.forEach(idx => {
      const item = filteredItems[idx];
      if (!item || imageCache[item.url] || ["mp4", "webm"].includes((item.ext || "").toLowerCase())) return;
      const img = new Image();
      img.src = item.url;
      img.onload = () => setImageCache(prev => ({ ...prev, [item.url]: true }));
    });
  }, [currentIndex, filteredItems, imageCache]);

  useEffect(() => {
    const threshold = Math.max(0, items.length - 20);
    if (hasMoreItems && !isLoadingMore && currentIndex >= threshold && items.length > 0) {
      loadMoreItems();
    }
  }, [currentIndex, items.length, hasMoreItems, isLoadingMore]);


  // --- RENDER ---
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <div className="border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center justify-between pt-4">
            <div className="flex gap-4">
              <button onClick={() => setActiveTab('viewer')} className={`px-4 py-2 font-medium border-b-2 transition ${activeTab === 'viewer' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}>Viewer</button>
              <button onClick={() => setActiveTab('feeds')} className={`px-4 py-2 font-medium border-b-2 transition flex items-center gap-2 ${activeTab === 'feeds' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}><Rss className="w-4 h-4" />Feeds</button>
            </div>
            <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:text-gray-200" title="Settings"><Settings className="w-5 h-5" /></button>
          </div>
        </div>
      </div>

      {/* Viewer Tab */}
      {activeTab === 'viewer' && (
        <>
          <div className="border-b border-gray-700 p-4">
            <div className="max-w-7xl mx-auto">
              <div className="flex gap-4 items-center flex-wrap">
                <div className="flex-1 min-w-[200px] relative">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <input type="text" placeholder="Search tags..." value={searchTags} onChange={(e) => setSearchTags(e.target.value)} className="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500" />
                </div>
                <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="px-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500">
                  <option value="default">Default Order</option>
                  <option value="random">Random</option>
                  <option value="score">By Score</option>
                  <option value="newest">Newest First</option>
                  <option value="oldest">Oldest First</option>
                </select>
                <select
                  value={filterRating}
                  onChange={(e) => setFilterRating(e.target.value)}
                  className="px-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500"
                >
                  <option value="all">All Ratings</option>
                  <option value="s">Safe</option>
                  <option value="q">Questionable</option>
                  <option value="e">Explicit</option>
                  <option value="nsfw">All NSFW (Q+E)</option>
                </select>
                <select 
                  value={filterSource} 
                  onChange={(e) => setFilterSource(e.target.value)}
                  className="px-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500"
                >
                  <option value="all">All Sources</option>
                  <option value="e621">e621 Only</option>
                  <option value="furaffinity">FurAffinity Only</option>
                </select>
                <div className="text-gray-400 text-sm">Showing {filteredItems.length} <span className="mx-1">•</span> Loaded {items.length} <span className="mx-1">•</span> Total {totalDatabaseItems}</div>
              </div>
              {selectedTags.length > 0 && (
                <div className="mt-3 flex gap-2 flex-wrap">
                  {selectedTags.map(tag => ( <button key={tag} onClick={() => toggleTag(tag)} className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded-full text-sm flex items-center gap-1">{tag}<X className="w-3 h-3" /></button> ))}
                </div>
              )}
            </div>
          </div>
          {initialLoading ? (
            <div className="max-w-7xl mx-auto p-12 flex items-center justify-center"><Loader2 className="w-10 h-10 animate-spin text-purple-500" /><span className="ml-3 text-gray-400">Loading library...</span></div>
          ) : filteredItems.length > 0 ? (
            <div className="max-w-7xl mx-auto p-4">
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                <div className="lg:col-span-3">
                  <div className={viewerOverlay ? "fixed inset-0 z-50 bg-black" : "bg-gray-800 rounded-lg overflow-hidden"} onMouseMove={() => viewerOverlay && pokeHud()} onMouseDown={() => viewerOverlay && pokeHud()} onWheel={() => viewerOverlay && pokeHud()} onTouchStart={() => viewerOverlay && pokeHud()}>
                    {currentItem && (
                      <div className={viewerOverlay ? "relative w-full h-full" : "relative bg-black"}>
                        {imageLoading && <div className="absolute inset-0 flex items-center justify-center z-10"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div></div>}
                        {viewerOverlay && (<><div className="absolute inset-y-0 left-0 w-1/2 z-0 cursor-pointer" onClick={() => goToPrev(true)} /><div className="absolute inset-y-0 right-0 w-1/2 z-0 cursor-pointer" onClick={() => goToNext(true)} /></>)}
                        <div className={viewerOverlay ? "w-full h-full flex items-center justify-center bg-black" : "bg-black"}>
                          {isVideo ? (
                            <video key={currentItem.url} src={currentItem.url} controls autoPlay loop={!waitForVideoEnd || !isSlideshow} muted={autoMuteVideos} className={`w-full h-auto object-contain transition-opacity duration-300 ${viewerOverlay ? 'max-h-full' : 'max-h-[70vh]'} ${fadeIn ? "opacity-100" : "opacity-0"}`} style={viewerOverlay ? { pointerEvents: 'none' } : undefined} onLoadedData={(e) => { const video = e.currentTarget; if (!autoMuteVideos) video.volume = 1.0; setImageLoading(false); }} onLoadStart={() => setImageLoading(true)} onError={() => { setImageLoading(false); console.error("Video load error"); }} onEnded={() => { if (waitForVideoEnd && isSlideshow) goToNext(); }} />
                          ) : (
                            <img src={currentItem.url} alt="Favorite" className={`w-full h-auto object-contain transition-opacity duration-300 ${viewerOverlay ? 'max-h-full' : 'max-h-[70vh]'} ${fadeIn ? "opacity-100" : "opacity-0"}`} onLoad={() => setImageLoading(false)} onLoadStart={() => setImageLoading(true)} onError={(e) => { setImageLoading(false); const img = e.currentTarget; img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%23374151' width='400' height='300'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='%239CA3AF' font-size='20'%3EImage not found%3C/text%3E%3C/svg%3E"; }} />
                          )}
                        </div>
                        <div className={viewerOverlay ? ["absolute bottom-6 left-1/2 -translate-x-1/2", "transition-all duration-300 ease-out", showHud ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"].join(" ") : "p-4 bg-gray-800 border-t border-gray-700"} onMouseEnter={() => { if (viewerOverlay) { hudHoverRef.current = true; setShowHud(true); } }} onMouseLeave={() => { if (viewerOverlay) { hudHoverRef.current = false; scheduleHudHide(); } }}>
                          <div className={viewerOverlay ? "relative z-20 px-6 py-4 bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-700/50 shadow-2xl" : ""} onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-center gap-2">
                              {!viewerOverlay && <button onClick={() => goToPrev(true)} className="p-2 bg-gray-700 hover:bg-gray-600 rounded"><ChevronLeft className="w-5 h-5" /></button>}
                              <button onClick={() => setIsSlideshow(!isSlideshow)} className="p-2 bg-purple-600 hover:bg-purple-700 rounded"><>{isSlideshow ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}</></button>
                              <select value={slideshowSpeed} onChange={(e) => setSlideshowSpeed(Number(e.target.value))} className="px-3 py-2 bg-gray-700 border border-gray-600 rounded"><option value={1000}>1s</option><option value={3000}>3s</option><option value={5000}>5s</option><option value={10000}>10s</option></select>
                              <button onClick={() => setAutoMuteVideos(!autoMuteVideos)} className={`p-2 rounded ${autoMuteVideos ? 'bg-purple-600 hover:bg-purple-700' : 'bg-gray-700 hover:bg-gray-600'}`} title="Mute all videos">{autoMuteVideos ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}</button>
                              <button onClick={() => setWaitForVideoEnd(!waitForVideoEnd)} className={`p-2 rounded ${waitForVideoEnd ? 'bg-purple-600 hover:bg-purple-700' : 'bg-gray-700 hover:bg-gray-600'}`} title="Wait for videos to finish">{<Clock className="w-5 h-5" />}</button>
                              <button onClick={() => { setViewerOverlay((v) => !v); toggleFullscreen(); }} className="p-2 bg-gray-700 hover:bg-gray-600 rounded" title={viewerOverlay ? "Exit full viewer" : "Full viewer"}><Maximize className="w-5 h-5" /></button>
                              {!viewerOverlay && <button onClick={deleteCurrentItem} className="p-2 bg-gray-700 hover:bg-red-600 rounded text-gray-400 hover:text-white transition-colors" title="Move to trash"><Trash2 className="w-5 h-5" /></button>}
                              {!viewerOverlay && <button onClick={() => goToNext(true)} className="p-2 bg-gray-700 hover:bg-gray-600 rounded"><ChevronRight className="w-5 h-5" /></button>}
                            </div>
                            {!viewerOverlay && <div className="text-center text-gray-400 text-sm mt-4">{currentIndex + 1} / {filteredItems.length}</div>}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  {currentItem && (
                    <div className="mt-4 bg-gray-800 rounded-lg p-4">
                      <div className="text-sm text-gray-400 mb-2">
                        {currentItem.source === 'e621' && (<button onClick={() => openExternalUrl(`https://e621.net/posts/${currentItem.id}`)} className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0">e621</button>)}
                        {currentItem.sources?.slice(0, 3).map((source, i) => (<span key={i}>{' • '}<button onClick={() => openExternalUrl(source)} className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0" title={source}>{getSocialMediaName(source)}</button></span>))}
                        {currentItem.artist?.map((artist, i) => (<span key={i}>{' • Artist: '}{i > 0 && ', '}<button onClick={() => openExternalUrl(`https://e621.net/posts?tags=${artist}`)} className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0">{artist}</button></span>))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <div className="flex flex-wrap gap-2 items-center">
                          {/* NEW EDIT BUTTON */}
                          <button
                            onClick={() => {
                              setEditingTags([...(currentItem.tags || [])]);
                              setNewTagInput("");
                              setShowTagModal(true);
                            }}
                            className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 hover:text-white transition-colors"
                            title="Edit Tags"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>

                          {/* Existing Tag List */}
                          {[...(currentItem.tags || [])]
                            .sort((a, b) => a.localeCompare(b))
                            .map((tag, i) => (
                              <button
                                key={i}
                                onClick={() => toggleTag(tag)}
                                className={`px-2 py-1 rounded text-xs ${
                                  selectedTags.includes(tag)
                                    ? 'bg-purple-600'
                                    : 'bg-gray-700 hover:bg-gray-600'
                                }`}
                              >{tag}
                              </button>
                            ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="lg:col-span-1">
                  <div className="bg-gray-800 rounded-lg p-4">
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2"><Tag className="w-4 h-4" />Popular Tags</h3>
                    <div className="max-h-[70vh] overflow-y-auto space-y-1">
                      {allTags.slice(0, 50).map(tag => (<button key={tag} onClick={() => toggleTag(tag)} className={`w-full text-left px-2 py-1 rounded text-sm hover:bg-gray-700 ${selectedTags.includes(tag) ? 'bg-purple-600' : ''}`}>{tag} <span className="text-gray-500">({items.filter(item => item.tags?.includes(tag)).length})</span></button>))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
  <div className="text-center py-20 text-gray-400">
    {!libraryRoot ? (
      // STATE 1: First Run / No Library
      <div className="animate-in fade-in zoom-in duration-300">
        <Database className="w-20 h-20 mx-auto mb-6 text-purple-500 opacity-80" />
        <h2 className="text-3xl font-bold text-white mb-3">Welcome!</h2>
        <p className="text-gray-400 mb-8 max-w-md mx-auto">
          To get started, select a folder where your favorites will be stored.
          <br />
          <span className="text-sm opacity-75">(You can create a new empty folder or select an existing one)</span>
        </p>
        <button
          onClick={changeLibraryRoot}
          className="px-8 py-4 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold text-lg shadow-lg hover:shadow-purple-500/20 transition-all transform hover:-translate-y-1"
        >
          Select Library Folder
        </button>
      </div>
    ) : (
      // STATE 2: Library Selected but Empty
      <div>
        <Upload className="w-16 h-16 mx-auto mb-4 opacity-50" />
        <p className="text-xl font-semibold text-gray-200">Library is Ready</p>
        <p className="text-sm mt-2 mb-6 text-gray-400">
          Your database is set up at:
          <br />
          <span className="font-mono text-xs bg-gray-800 px-2 py-1 rounded mt-1 inline-block">{libraryRoot}</span>
        </p>
        <div className="p-4 bg-gray-800 rounded-lg max-w-md mx-auto border border-gray-700">
          <p className="text-sm mb-3">Go to <b>Settings → e621</b> to log in and sync your favorites.</p>
          <button 
            onClick={() => setShowSettings(true)}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
          >
            Open Settings
          </button>
        </div>
      </div>
    )}
  </div>
          )}
        </>
      )}

      {/* Feeds Tab */}
      {activeTab === 'feeds' && (
        <div className="max-w-7xl mx-auto p-4">
          <div className="flex justify-center items-center gap-2 mb-6 flex-wrap">
            {feeds.map((feed) => (<button key={feed.id} onClick={() => { setSelectedFeedId(feed.id); if (!feedPosts[feed.id] || feedPosts[feed.id].length === 0) { fetchFeedPosts(feed.id, feed.query, { reset: true }); } }} className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${ selectedFeedId === feed.id ? 'bg-purple-600 text-white shadow-lg scale-105' : 'bg-gray-800 text-gray-300 hover:bg-gray-700' }`} > {feed.name} </button>))}
            <button onClick={() => { setEditingFeedId(null); setNewFeedName(''); setNewFeedQuery(''); setShowAddFeedModal(true); }} className="px-4 py-2 rounded-full text-sm font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 transition-all flex items-center gap-2"><Plus className="w-4 h-4" />Add Feed</button>
          </div>
          {selectedFeedId && feeds.find(f => f.id === selectedFeedId) ? (
            <div className="bg-gray-800 rounded-lg p-4">
              {(() => {
                const feed = feeds.find(f => f.id === selectedFeedId)!;
                return (
                  <>
                    <div className="flex items-center justify-between mb-4">
                      <div><h2 className="text-2xl font-bold">{feed.name}</h2><p className="text-sm text-gray-400 mt-1">{feed.query}</p></div>
                      <div className="flex gap-2">
                        <button onClick={() => fetchFeedPosts(feed.id, feed.query, { reset: true })} disabled={loadingFeeds[feed.id]} title="Refresh" className="p-2 bg-gray-700 hover:bg-gray-600 rounded">{loadingFeeds[feed.id] ? (<Loader2 className="w-5 h-5 animate-spin" />) : (<RefreshCw className="w-5 h-5" /> )}</button>
                        <button onClick={() => { setNewFeedName(feed.name); setNewFeedQuery(feed.query); setEditingFeedId(feed.id); setShowAddFeedModal(true); }} className="p-2 bg-gray-700 hover:bg-gray-600 rounded" title="Edit feed"><Pencil className="w-5 h-5" /></button>
                        <button onClick={() => { removeFeed(feed.id); setSelectedFeedId(null); }} className="p-2 bg-red-600 hover:bg-red-700 rounded" title="Delete feed"><Trash2 className="w-5 h-5" /></button>
                      </div>
                    </div>
                    {feedPosts[feed.id] && feedPosts[feed.id].length > 0 ? (
                      <>
                        <Masonry breakpointCols={feedBreakpoints} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                          {feedPosts[feed.id].map((post: any) => {
                            const busy = !!feedActionBusy[post.id]; const isRemoteFav = !!post.is_favorited; const imageUrl = post.sample?.url || post.file?.url || post.preview?.url; const sourceUrl = `https://e621.net/posts/${post.id}`; const artists = post.tags?.artist || []; const w = post.sample?.width || post.file?.width || 1; const h = post.sample?.height || post.file?.height || 1;
                            return (
                              <div key={post.id} className="relative group bg-gray-700 rounded overflow-hidden">
                                {downloadedE621Ids.has(post.id) && <div className="absolute top-2 left-2 z-20 bg-gray-900/70 text-gray-200 px-2 py-1 rounded flex items-center gap-1"><Database className="w-4 h-4" /></div>}
                                {imageUrl ? (<>
                                  <img src={imageUrl} alt="" className="w-full object-cover rounded" style={{ aspectRatio: `${w} / ${h}` }} loading="lazy" referrerPolicy="no-referrer" />
                                  <button onClick={() => ensureFavorite(feed.id, post)} disabled={busy} className={`absolute top-2 right-2 p-2 rounded-full transition z-20 ${isRemoteFav ? "bg-yellow-500 text-yellow-900" : "bg-gray-900/70 text-gray-300 hover:bg-gray-900/90"} ${busy ? "opacity-60 cursor-not-allowed" : ""}`}>{busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Star className={`w-5 h-5 ${isRemoteFav ? "fill-current" : ""}`} />}</button>
                                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center gap-2 z-10" style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}><p className="text-xs text-white">Score: {post.score?.total || 0} | ❤️ {post.fav_count || 0}</p>{artists.length > 0 && <p className="text-xs text-gray-300">{artists.slice(0, 2).join(", ")}</p>}<button onClick={() => openExternalUrl(sourceUrl)} className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded text-xs text-white">View Source</button></div>
                                </>) : <div className="w-full h-48 flex items-center justify-center bg-gray-800"><p className="text-gray-500 text-sm">No image</p></div>}
                              </div>
                            );
                          })}
                        </Masonry>
                        <InfiniteSentinel disabled={!e621CredInfo.username || !e621CredInfo.has_api_key || !!loadingFeeds[feed.id] || !!feedPaging[feed.id]?.done} onVisible={() => fetchFeedPosts(feed.id, feed.query)} />
                        {feedPaging[feed.id]?.done && <div className="text-center text-gray-500 text-sm py-4">End of results</div>}
                      </>
                    ) : <div className="text-center py-20 text-gray-400 italic">"Nobody here but us dergs"</div>}
                  </>
                );
              })()}
            </div>
          ) : null}
          {!selectedFeedId && feeds.length > 0 && <div className="text-center py-20 text-gray-400"><p className="text-xl mb-2">Select a feed to view posts</p></div>}
          {feeds.length === 0 && <div className="text-center py-20 text-gray-400"><Rss className="w-16 h-16 mx-auto mb-4 opacity-50" /><p className="text-xl">No feeds yet</p><p className="text-sm mt-2">Click the "Add Feed" button above to get started</p></div>}
          {showAddFeedModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60" onClick={() => { setShowAddFeedModal(false); setEditingFeedId(null); setNewFeedName(''); setNewFeedQuery(''); }} />
              <div className="relative z-10 w-full max-w-xl bg-gray-800 border border-gray-700 rounded-lg p-6">
                <h2 className="text-2xl font-bold mb-4">{editingFeedId ? 'Edit Feed' : 'Add New Feed'}</h2>
                <div className="space-y-4">
                  <div><label className="text-sm text-gray-400 mb-1 block">Feed Name</label><input type="text" placeholder="e.g., Cute Foxes" value={newFeedName} onChange={(e) => setNewFeedName(e.target.value)} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500" /></div>
                  <div><label className="text-sm text-gray-400 mb-1 block">Search Query</label><input type="text" placeholder="e.g., fox cute rating:s score:>200" value={newFeedQuery} onChange={(e) => setNewFeedQuery(e.target.value)} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500" /><p className="text-xs text-gray-500 mt-1">Use e621 search syntax.</p></div>
                  <div className="flex gap-3 justify-end">
                    <button onClick={() => { setNewFeedName(''); setNewFeedQuery(''); setShowAddFeedModal(false); setEditingFeedId(null); }} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded">Cancel</button>
                    <button onClick={() => {
                      if (!newFeedQuery.trim()) { alert('Please enter a search query'); return; }
                      if (editingFeedId) {
                        const updatedFeeds = feeds.map(f => f.id === editingFeedId ? { ...f, name: newFeedName.trim() || newFeedQuery, query: newFeedQuery.trim() } : f);
                        saveFeeds(updatedFeeds);
                      } else {
                        const feed = { id: Date.now(), name: newFeedName.trim() || newFeedQuery, query: newFeedQuery.trim() };
                        saveFeeds([...feeds, feed]);
                        setSelectedFeedId(feed.id);
                        fetchFeedPosts(feed.id, feed.query, { reset: true });
                      }
                      setNewFeedQuery(''); setNewFeedName(''); setShowAddFeedModal(false); setEditingFeedId(null);
                    }} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded">{editingFeedId ? 'Save Changes' : 'Create Feed'}</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowSettings(false)} />
          <div className="relative z-10 w-full max-w-xl max-h-[90vh] bg-gray-800 border border-gray-700 rounded-lg flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-gray-700 flex-shrink-0"><h2 className="text-lg font-semibold">Settings</h2><button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-200"><X className="w-5 h-5" /></button></div>
            <div className="overflow-y-auto p-5 space-y-4">
              <div><h3 className="text-lg font-semibold mb-2">Library</h3>
                <div className="text-sm text-gray-400 mb-1">Library folder</div><div className="text-xs text-gray-200 break-all bg-gray-900 border border-gray-700 rounded p-2">{libraryRoot || "(not set)"}</div>
                <div className="flex gap-2 mt-3"><button onClick={changeLibraryRoot} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded">Change / Create Librar</button><button onClick={async () => { const ok = await confirmDialog("Unload the current library?", { title: "Unload Library", okLabel: "Yes, unload", cancelLabel: "Cancel" }); if (!ok) return; try { await invoke("clear_library_root"); setLibraryRoot(""); setItems([]); setAllTags([]); setTotalDatabaseItems(0); setHasMoreItems(true); setDownloadedE621Ids(new Set()); setShowSettings(false); } catch (e) { console.error("Failed to unload:", e); alert("Failed to unload: " + String(e)); } }} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded">Unload Library</button></div>
              </div>
              <div className="border-t border-gray-700 pt-4"><h3 className="text-lg font-semibold mb-2">Viewer</h3>
                <div><label className="text-sm text-gray-400 mb-1 block">Default sort order</label><select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"><option value="default">Default</option><option value="random">Random</option><option value="score">Score</option><option value="newest">Newest</option><option value="oldest">Oldest</option></select></div>
                <div className="mt-3"><label className="text-sm text-gray-400 mb-1 block">Items to load per batch</label><select value={itemsPerPage} onChange={(e) => handlePageSizeChange(Number(e.target.value))} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"><option value={50}>50</option><option value={100}>100 (Recommended)</option><option value={200}>200</option><option value={500}>500</option><option value={1000}>1000</option></select></div>
              </div>
              <div className="border-t border-gray-700 pt-4"><h3 className="text-lg font-semibold mb-2">e621</h3>
                <div className="flex gap-2 mb-2"><input type="text" placeholder="Username" value={apiUsername} onChange={(e) => setApiUsername(e.target.value)} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded" /><input type="password" placeholder={e621CredInfo.has_api_key ? "API Key (saved)" : "API Key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded" /></div>
                <div className="flex gap-2 items-center flex-wrap"><button onClick={saveE621Credentials} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded">Save</button><button onClick={testE621Credentials} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded">Test</button><button onClick={async () => { const ok = await confirmDialog("Clear saved e621 credentials?", { title: "Clear Credentials", okLabel: "Yes, clear", cancelLabel: "Cancel" }); if (!ok) return; try { await invoke("e621_clear_credentials"); setApiUsername(""); setApiKey(""); await refreshE621CredInfo(); alert("Credentials cleared."); } catch (e) { console.error("Failed to clear:", e); alert("Failed to clear: " + String(e)); } }} disabled={!e621CredInfo.has_api_key && !e621CredInfo.username} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded disabled:opacity-50">Clear</button><div className="text-xs text-gray-400">Key: {e621CredInfo.has_api_key ? "saved" : "not set"}</div></div>
              </div>
              <div className="border-t border-gray-700 pt-4"><h3 className="text-lg font-semibold mb-2">Sync Favorites</h3>
                <div className="flex gap-2 items-center"><input type="text" placeholder="Stop after N (optional)" value={syncMaxNew} onChange={(e) => setSyncMaxNew(e.target.value)} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded" /><button onClick={startSync} disabled={!!syncStatus?.running} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50">{syncStatus?.running ? "Running..." : "Start"}</button><button onClick={cancelSync} disabled={!syncStatus?.running} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded disabled:opacity-50">Cancel</button></div>
                {syncStatus && <div className="mt-3 text-sm text-gray-300 space-y-1"><div>Scanned: {syncStatus.scanned_pages} pages, {syncStatus.scanned_posts} posts</div><div>Skipped: {syncStatus.skipped_existing}</div><div>Downloaded: {syncStatus.downloaded_ok}</div><div>Failed: {syncStatus.failed_downloads}</div><div>Unavailable: {syncStatus.unavailable}</div>{syncStatus.last_error && <div className="text-red-300 break-words">Error: {syncStatus.last_error}</div>}<button onClick={loadUnavailable} className="mt-2 px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm">View unavailable</button></div>}
              </div>
              {showUnavailable && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                  <div className="absolute inset-0 bg-black/60" onClick={() => setShowUnavailable(false)} />
                  <div className="relative z-10 w-full max-w-3xl bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <div className="flex items-center justify-between mb-4"><h2 className="text-lg font-semibold">Unavailable favorites</h2><button onClick={() => setShowUnavailable(false)} className="text-gray-400 hover:text-gray-200"><X className="w-5 h-5" /></button></div>
                    <div className="max-h-[60vh] overflow-y-auto space-y-3">
                      {unavailableList.length === 0 ? (
                        <div className="text-gray-400">No unavailable posts recorded.</div>
                      ) : (
                        unavailableList.map((u) => (
                          <div key={`${u.source}:${u.source_id}`} className="bg-gray-900 border border-gray-700 rounded p-3">
                            <div className="text-sm text-gray-200"><span className="text-gray-400">{u.source}</span> #{u.source_id} <span className="text-gray-500">• {u.reason}</span> <span className="text-gray-500">• {u.seen_at}</span></div>
                            <div className="mt-2 text-xs text-gray-300 space-y-1">
                              {u.sources.length > 0 ? ( u.sources.map((s, i) => (<div key={i}><button onClick={() => openExternalUrl(s)} className="text-purple-400 underline break-all cursor-pointer bg-transparent border-none p-0 text-left">{s}</button></div>)) ) : <div className="text-gray-500">No source links.</div>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div className="border-t border-gray-700 pt-4 mt-4">
                <h3 className="text-lg font-semibold mb-2">FurAffinity Import</h3>
                <div className="text-xs text-gray-400 mb-2">
                  Requires your login cookies (a and b) to scan favorites.
                </div>
                
                <div className="flex gap-2 mb-2">
                  <input 
                    type="text" 
                    placeholder="Cookie A" 
                    value={faCreds.a} 
                    onChange={e => setFaCreds(prev => ({...prev, a: e.target.value}))}
                    className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded"
                  />
                  <input 
                    type="text" 
                    placeholder="Cookie B" 
                    value={faCreds.b} 
                    onChange={e => setFaCreds(prev => ({...prev, b: e.target.value}))}
                    className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded"
                  />
                </div>

                <div className="flex gap-2 items-center">
                  <button onClick={startFaSync} disabled={faStatus?.running} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50">
                    {faStatus?.running ? "Scanning..." : "Start Import"}
                  </button>
                  {faStatus?.running && (
                    <button onClick={cancelFaSync} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded">
                      Stop
                    </button>
                  )}
                </div>

                {faStatus && (
                  <div className="mt-3 text-sm text-gray-300 space-y-1">
                    <div className="mt-3 text-sm text-gray-300 space-y-1">
                    <div>Status: {faStatus.current_message}</div>
                    <div>Scanned: {faStatus.scanned}</div>
                    <div>Skipped (URL): {faStatus.skipped_url}</div>
                    <div>Skipped (MD5): {faStatus.skipped_md5}</div>
                    <div className="text-purple-400">Upgraded to e621: {faStatus.upgraded}</div> {/* NEW */}
                    <div className="text-green-400">FA Exclusives: {faStatus.imported}</div>
                    <div>Errors: {faStatus.errors}</div>
                  </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Edit Tags Modal */}
      {showTagModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowTagModal(false)} />
          <div className="relative z-10 w-full max-w-lg bg-gray-800 border border-gray-700 rounded-lg p-6 flex flex-col max-h-[80vh]">
            <h2 className="text-xl font-bold mb-4">Edit Tags</h2>
            
            {/* Input */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="Add a tag..."
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTagInput.trim()) {
                    e.preventDefault();
                    const tag = newTagInput.trim().toLowerCase();
                    if (!editingTags.includes(tag)) {
                      setEditingTags([...editingTags, tag]);
                    }
                    setNewTagInput("");
                  }
                }}
                className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
                autoFocus
              />
              <button
                onClick={() => {
                  if (newTagInput.trim()) {
                    const tag = newTagInput.trim().toLowerCase();
                    if (!editingTags.includes(tag)) {
                      setEditingTags([...editingTags, tag]);
                    }
                    setNewTagInput("");
                  }
                }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded"
              >
                Add
              </button>
            </div>

            {/* Tag List */}
            <div className="flex-1 overflow-y-auto p-2 bg-gray-900/50 rounded border border-gray-700 mb-4 content-start">
              <div className="flex flex-wrap gap-2">
                {editingTags.map(tag => (
                  <span key={tag} className="px-2 py-1 bg-purple-900/50 border border-purple-500/30 rounded text-sm flex items-center gap-1">
                    {tag}
                    <button
                      onClick={() => setEditingTags(editingTags.filter(t => t !== tag))}
                      className="hover:text-red-400"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {editingTags.length === 0 && (
                  <div className="text-gray-500 italic text-sm p-2">No tags yet.</div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowTagModal(false)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded"
              >
                Cancel
              </button>
              <button
                onClick={saveTags}
                className="px-6 py-2 bg-purple-600 hover:bg-purple-700 rounded font-medium"
              >
                Save Tags
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfiniteSentinel({ onVisible, disabled }: { onVisible: () => void; disabled?: boolean; }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) onVisible(); }, { root: null, rootMargin: "800px 0px", threshold: 0 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [onVisible, disabled]);
  return <div ref={ref} className="h-10" />;
}