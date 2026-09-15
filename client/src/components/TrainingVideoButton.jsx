// Per-module training video button (mam 2026-08-19: "give one small training
// video button like admin add and everyone can view").
//
// Drop <TrainingVideoButton module="procurement" /> into any page's toolbar.
// Everyone sees the button and can watch; only admin sees Add / Remove.
// YouTube links only — nothing is uploaded, so it costs no disk and no
// streaming load on the VPS.
import { useEffect, useState, useCallback } from 'react';
import { FiPlayCircle, FiTrash2, FiExternalLink, FiPlus } from 'react-icons/fi';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

export default function TrainingVideoButton({ module, label = 'Training' }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [open, setOpen] = useState(false);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(null);      // the video being watched
  const [form, setForm] = useState({ title: '', url: '' });
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    if (!module) return;
    setLoading(true);
    api.get(`/module-videos?module=${encodeURIComponent(module)}`)
      .then(r => setVideos(r.data || []))
      .catch(() => setVideos([]))
      .finally(() => setLoading(false));
  }, [module]);

  // Load the count once so the button can show it without opening the dialog.
  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return toast.error('Give the video a title');
    if (!form.url.trim()) return toast.error('Paste the YouTube link');
    setAdding(true);
    try {
      const r = await api.post('/module-videos', { module, title: form.title, url: form.url });
      toast.success(r.data.message);
      setForm({ title: '', url: '' });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not add the video');
    } finally { setAdding(false); }
  };

  const remove = async (v) => {
    if (!window.confirm(`Remove "${v.title}"? The video stays on YouTube — this only takes it off this page.`)) return;
    try {
      await api.delete(`/module-videos/${v.id}`);
      toast.success('Removed');
      if (playing?.id === v.id) setPlaying(null);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Nothing to show and nobody who could add one → don't clutter the toolbar.
  if (!isAdmin && videos.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn btn-secondary text-xs sm:text-sm px-2 sm:px-3 py-1.5 flex items-center gap-1.5 shrink-0"
        title={videos.length ? `${videos.length} training video${videos.length === 1 ? '' : 's'} for this page` : 'No training video yet — add one'}
        aria-label="Training videos"
      >
        <FiPlayCircle size={16} className="text-red-600 shrink-0" />
        <span className="hidden sm:inline">{label}</span>
        {videos.length > 0 && (
          <span className="text-[11px] font-semibold text-gray-500">({videos.length})</span>
        )}
      </button>

      <Modal isOpen={open} onClose={() => { setOpen(false); setPlaying(null); }} title={`▶ ${label}`} wide>
        <div className="space-y-3">
          {playing && (
            <div>
              <div className="relative w-full rounded-lg overflow-hidden bg-black" style={{ paddingTop: '56.25%' }}>
                <iframe
                  className="absolute inset-0 w-full h-full"
                  src={playing.embed_url}
                  title={playing.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
              <div className="flex items-center justify-between mt-2">
                <p className="text-sm font-semibold text-gray-800">{playing.title}</p>
                <div className="flex items-center gap-2">
                  <a href={playing.watch_url} target="_blank" rel="noreferrer"
                    className="text-xs text-blue-700 hover:underline inline-flex items-center gap-1">
                    <FiExternalLink size={12} /> Open in YouTube
                  </a>
                  <button onClick={() => setPlaying(null)} className="text-xs text-gray-500 hover:text-gray-700">Back to list</button>
                </div>
              </div>
            </div>
          )}

          {!playing && (
            <>
              {loading && <p className="text-sm text-gray-400">Loading…</p>}
              {!loading && videos.length === 0 && (
                <p className="text-sm text-gray-500">
                  No training video for this page yet.
                  {isAdmin ? ' Add one below — everyone will be able to watch it.' : ' Ask your admin to add one.'}
                </p>
              )}
              {videos.length > 0 && (
                <ul className="divide-y border rounded-lg">
                  {videos.map(v => (
                    <li key={v.id} className="flex items-center gap-3 p-2.5 hover:bg-gray-50">
                      <button onClick={() => setPlaying(v)} className="flex items-center gap-2.5 flex-1 text-left min-w-0">
                        {v.video_id
                          ? <img src={`https://img.youtube.com/vi/${v.video_id}/default.jpg`} alt=""
                              className="w-16 h-12 object-cover rounded flex-shrink-0 bg-gray-200" />
                          : <span className="w-16 h-12 rounded bg-gray-200 flex-shrink-0" />}
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-gray-800 truncate">{v.title}</span>
                          <span className="block text-[11px] text-gray-400">
                            Added by {v.created_by_name || 'admin'}
                          </span>
                        </span>
                      </button>
                      {isAdmin && (
                        <button onClick={() => remove(v)}
                          className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 flex-shrink-0"
                          title="Remove from this page"><FiTrash2 size={12} /></button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {isAdmin && (
                <form onSubmit={save} className="border-t pt-3 space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Add a video</p>
                  <input className="input w-full" placeholder="Title — e.g. How to raise an indent"
                    value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                  <input className="input w-full" placeholder="Paste the YouTube link (youtube.com/watch?v=… or youtu.be/…)"
                    value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
                  <p className="text-[11px] text-gray-400">
                    Tip: upload the recording to YouTube as <b>Unlisted</b> — only people with the link can see it, and it never appears in search.
                  </p>
                  <div className="flex justify-end">
                    <button type="submit" disabled={adding} className="btn btn-primary text-sm flex items-center gap-1 disabled:opacity-50">
                      <FiPlus size={14} /> {adding ? 'Adding…' : 'Add Video'}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
