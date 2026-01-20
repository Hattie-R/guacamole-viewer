import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import FavoritesViewer from "./FavoritesViewer";

type AppConfig = {
  library_root?: string | null;
};

type Status = {
  ok: boolean;
  message: string;
};

export default function App() {
  const [config, setConfig] = useState<AppConfig>({});
  const [status, setStatus] = useState<string>("");

  async function refreshConfig() {
    const cfg = await invoke<AppConfig>("get_config");
    setConfig(cfg);
  }

  async function chooseLibraryRoot() {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;

    setStatus("Initializing library...");
    const res = await invoke<Status>("set_library_root", { libraryRoot: dir });
    setStatus(res.message);

    await refreshConfig();
  }

  useEffect(() => {
    refreshConfig().catch(console.error);
  }, []);

  if (!config.library_root) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-6">
        <div className="w-full max-w-xl bg-gray-800 border border-gray-700 rounded-lg p-6">
          <h1 className="text-2xl font-semibold mb-2">Local Favorites Library</h1>
          <p className="text-gray-300 mb-4">
            Choose a folder to store your library database, media, cache, and trash.
          </p>

          <button
            onClick={chooseLibraryRoot}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded"
          >
            Choose Library Folder
          </button>

          {status && <p className="text-sm text-gray-400 mt-3">{status}</p>}
        </div>
      </div>
    );
  }

  return <FavoritesViewer />;
}