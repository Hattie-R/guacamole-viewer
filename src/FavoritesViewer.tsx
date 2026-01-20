import { useState, useEffect, useRef } from "react";
import { Search, Upload, Play, Pause, ChevronLeft, ChevronRight, X, Tag, Trash2, Rss, Plus, Star, Maximize, Settings } from 'lucide-react';
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Masonry from "react-masonry-css";

type AppConfig = { library_root?: string | null };

type ImportResult = {
  imported: number;
  skipped: number;
  missing_files: number;
  errors: string[];
};

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

type Feed = { id: number; name: string; query: string };
type FeedPagingState = { beforeId: number | null; done: boolean };

export default function FavoritesViewer() {
  const [activeTab, setActiveTab] = useState('viewer');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [filteredItems, setFilteredItems] = useState<LibraryItem[]>([]);
  const [searchTags, setSearchTags] = useState('');
  const [sortOrder, setSortOrder] = useState('default');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isSlideshow, setIsSlideshow] = useState(false);
  const [slideshowSpeed, setSlideshowSpeed] = useState(3000);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [fadeIn, setFadeIn] = useState(true);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageCache, setImageCache] = useState<Record<string, boolean>>({});
  const [renameOnImport, setRenameOnImport] = useState(false);
  
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
  const feedBreakpoints = {
    default: 3,
    1024: 3,
    768: 2,
    520: 1,
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
  const importJsonDb = async () => {
  const file = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!file || Array.isArray(file)) return;

  const res = await invoke<ImportResult>("import_json", {
    jsonPath: file,
    renameFiles: renameOnImport,
  });

    alert(
      `Imported: ${res.imported}\nSkipped: ${res.skipped}\nMissing files: ${res.missing_files}`
    );

    await loadData();
  };

    const refreshLibraryRoot = async () => {
    const cfg = await invoke<AppConfig>("get_config");
    setLibraryRoot(cfg.library_root || "");
  };

  const changeLibraryRoot = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;

    await invoke("set_library_root", { libraryRoot: dir });
    await refreshLibraryRoot();
    await loadData(); // reload items from the new DB/root
  };


  useEffect(() => {
    loadData().catch(console.error);
    refreshLibraryRoot().catch(console.error);
    loadFeeds();
    loadApiCredentials();
  }, []);

  useEffect(() => {
    filterItems();
  }, [searchTags, items, selectedTags, sortOrder]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isSlideshow && filteredItems.length > 0) {
      interval = setInterval(() => {
        goToNext();
      }, slideshowSpeed);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isSlideshow, filteredItems.length, slideshowSpeed, currentIndex]);

  // Preload adjacent images with caching
  useEffect(() => {
    if (filteredItems.length > 0) {
      const preloadIndexes = [
        currentIndex,
        (currentIndex + 1) % filteredItems.length,
        (currentIndex + 2) % filteredItems.length,
        (currentIndex - 1 + filteredItems.length) % filteredItems.length
      ];
      
      preloadIndexes.forEach(idx => {
        const item = filteredItems[idx];
        if (item && !imageCache[item.url]) {
          const src = item?.url;
          if (!src) return;

          if (["mp4", "webm"].includes((item?.ext || "").toLowerCase())) return;
          const img = new Image();
          img.src = item.url;
          img.onload = () => {
            setImageCache(prev => ({...prev, [item.url]: true}));
          };
        }
      });
    }
  }, [currentIndex, filteredItems]);

  const loadApiCredentials = () => {
    const username = localStorage.getItem('e621_username');
    const key = localStorage.getItem('e621_api_key');
    if (username) setApiUsername(username);
    if (key) setApiKey(key);
  };

  const saveApiCredentials = () => {
    localStorage.setItem('e621_username', apiUsername);
    localStorage.setItem('e621_api_key', apiKey);
    alert('API credentials saved!');
  };

  const goToNext = () => {
    setFadeIn(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % filteredItems.length);
      setFadeIn(true);
    }, 150);
  };

  const goToPrev = () => {
    setFadeIn(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      setFadeIn(true);
    }, 150);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      //setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

    const loadData = async () => {
    const rows = await invoke<ItemDto[]>("list_items"); // returns ItemDto[]

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

    // Build tag list (same logic you already had)
    const tags = new Set<string>();
    mapped.forEach((item) => item.tags?.forEach((tag) => tags.add(tag)));

    const sortedTags: string[] = Array.from(tags).sort((a, b) => {
      const countA = mapped.filter((item) => item.tags?.includes(a)).length;
      const countB = mapped.filter((item) => item.tags?.includes(b)).length;
      return countB - countA;
    });
    setAllTags(sortedTags);
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
    if (!apiUsername || !apiKey) {
      alert('Please set your e621 API credentials in the settings below');
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
      const auth = btoa(`${apiUsername}:${apiKey}`);

      const LIMIT = 50;

      // e621 supports page=b<ID> to fetch posts before that id (good for infinite scroll)
      const beforeId = reset ? null : paging.beforeId;
      const pageParam = beforeId ? `b${beforeId}` : "1";

      const response = await fetch(
        `https://e621.net/posts.json?tags=${encodeURIComponent(query)}&limit=${LIMIT}&page=${encodeURIComponent(pageParam)}`,
        {
          headers: {
            'User-Agent': 'LocalFavoritesLibrary/0.1 (by you)',
            'Authorization': `Basic ${auth}`
          }
        }
      );

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const newPosts = data.posts || [];

      // append + dedupe by id
      setFeedPosts(prev => {
        const existing = reset ? [] : (prev[feedId] || []);
        const merged = [...existing, ...newPosts];

        const seen = new Set();
        const deduped = [];
        for (const p of merged) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            deduped.push(p);
          }
        }

        return { ...prev, [feedId]: deduped };
      });

      // update cursor: next request should fetch older than the smallest id we have
      const minId = newPosts.reduce((m: number, p: any) => Math.min(m, p.id), Number.POSITIVE_INFINITY);

      setFeedPaging(prev => ({
        ...prev,
        [feedId]: {
          beforeId: (minId !== Number.POSITIVE_INFINITY) ? minId : paging.beforeId,
          done: newPosts.length < LIMIT || newPosts.length === 0
        }
      }));
    } catch (error) {
      console.error('Error fetching feed:', error);
      const msg = error instanceof Error ? error.message : String(error);
      alert("Error fetching feed: " + msg);
    } finally {
      setLoadingFeeds(prev => ({ ...prev, [feedId]: false }));
    }
  };

  const isFavorited = (url: string) => {
    return items.some((item) => item.remote_url === url);
  };

  const toggleFavorite = (_post: any) => {
    alert("Download-to-library from Feeds is not implemented yet.");
  };

  const filterItems = () => {
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

    setFilteredItems(filtered);
    setCurrentIndex(0);
  };

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

    const confirmed = window.confirm("Move this item to trash?");
    if (!confirmed) return;

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
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setShowSettings(false)}
            />
            <div className="relative z-10 w-full max-w-xl bg-gray-800 border border-gray-700 rounded-lg p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Settings</h2>
                <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-200">
                  <X className="w-5 h-5" />
                </button>
              </div>

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
                <button
                  onClick={importJsonDb}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded">
                  <Upload className="inline w-4 h-4 mr-2" />
                  Import JSON
                </button>
              <label className="text-sm text-gray-300 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={renameOnImport}
                  onChange={(e) => setRenameOnImport(e.target.checked)}/>
                Rename files during import
              </label>
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
                  <div className="bg-gray-800 rounded-lg overflow-hidden">
                    {currentItem && (
                      <div className="relative bg-black">
                        {imageLoading && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
                          </div>
                        )}
                        {isVideo ? (
                          <video
                            key={currentItem.url}
                            src={currentItem.url}
                            controls
                            autoPlay
                            loop
                            className={`w-full h-auto max-h-[70vh] object-contain transition-opacity duration-300 ${
                              fadeIn ? 'opacity-100' : 'opacity-0'
                            }`}
                            onLoadedData={(e) => {
                              (e.currentTarget as HTMLVideoElement).volume = 1.0;
                              setImageLoading(false);
                            }}
                            onLoadStart={() => setImageLoading(true)}
                            onError={(e) => {
                              const img = e.currentTarget; // HTMLImageElement
                              img.src =
                                "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%23374151' width='400' height='300'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='%239CA3AF' font-size='20'%3EImage not found%3C/text%3E%3C/svg%3E";
                              setImageLoading(false);
                            }}
                          />
                        ) : (
                          <img
                            src={currentItem.url}
                            alt="Favorite"
                            className={`w-full h-auto max-h-[70vh] object-contain transition-opacity duration-300 ${
                              fadeIn ? 'opacity-100' : 'opacity-0'
                            }`}
                            onLoad={() => setImageLoading(false)}
                            onLoadStart={() => setImageLoading(true)}
                            onError={(e) => {
                              setImageLoading(false);
                              const img = e.currentTarget as HTMLImageElement;
                              img.src = "data:image/svg+xml,...";
                            }}
                          />
                        )}
                      </div>
                    )}
                    <div className="p-4 bg-gray-800 border-t border-gray-700">
                      <div className="flex items-center justify-between mb-4">
                        <button
                          onClick={goToPrev}
                          className="p-2 bg-gray-700 hover:bg-gray-600 rounded"
                        >
                          <ChevronLeft className="w-5 h-5" />
                        </button>

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
                            onClick={toggleFullscreen}
                            className="p-2 bg-gray-700 hover:bg-gray-600 rounded"
                          >
                            <Maximize className="w-5 h-5" />
                          </button>

                          <button
                            onClick={deleteCurrentItem}
                            className="p-2 bg-red-600 hover:bg-red-700 rounded"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>

                        <button
                          onClick={goToNext}
                          className="p-2 bg-gray-700 hover:bg-gray-600 rounded"
                        >
                          <ChevronRight className="w-5 h-5" />
                        </button>
                      </div>

                      <div className="text-center text-gray-400 text-sm">
                        {currentIndex + 1} / {filteredItems.length}
                      </div>
                    </div>
                  </div>

                  {currentItem && (
                    <div className="mt-4 bg-gray-800 rounded-lg p-4">
                      <div className="text-sm text-gray-400 mb-2">
                        Source: <a 
                          href={currentItem.sources?.[0] || `https://e621.net/posts/${currentItem.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-purple-400 hover:text-purple-300 underline"
                        >
                          e621
                        </a>
                        {currentItem.artist && currentItem.artist.length > 0 && (
                          <>
                            {' • Artist: '}
                            {currentItem.artist.map((artist, i) => (
                              <span key={i}>
                                {i > 0 && ', '}
                                <a
                                  href={`https://e621.net/posts?tags=${artist}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-purple-400 hover:text-purple-300 underline"
                                >
                                  {artist}
                                </a>
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
              <p className="text-xl">Import your favorites_db.json to get started</p>
              <p className="text-sm mt-2">Run the Python scraper first to generate the data file</p>
            </div>
          )}
        </>
      )}

      {/* Feeds Tab */}
      {activeTab === 'feeds' && (
        <div className="max-w-7xl mx-auto p-4">
          {/* API Credentials */}
          <div className="bg-gray-800 rounded-lg p-4 mb-6">
            <h3 className="text-lg font-semibold mb-3">e621 API Credentials</h3>
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
                placeholder="API Key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
              />
              <button
                onClick={saveApiCredentials}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded"
              >
                Save
              </button>
            </div>
            <p className="text-xs text-gray-500">Get your API key from e621.net account settings</p>
          </div>

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
                    const imageUrl = post.sample?.url || post.file?.url || post.preview?.url;
                    const fileUrl = post.file?.url || imageUrl;
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
                              onClick={() => toggleFavorite(post)}
                              className={`absolute top-2 right-2 p-2 rounded-full transition z-20 ${
                                isFavorited(fileUrl)
                                  ? "bg-yellow-500 text-yellow-900"
                                  : "bg-gray-900/70 text-gray-300 hover:bg-gray-900/90"
                              }`}
                            >
                              <Star className={`w-5 h-5 ${isFavorited(fileUrl) ? "fill-current" : ""}`} />
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
                              <a
                                href={sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded text-xs text-white"
                              >
                                View Source
                              </a>
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
                disabled={!!loadingFeeds[feed.id] || !!feedPaging[feed.id]?.done}
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