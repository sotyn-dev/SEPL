import { useState } from 'react';
import { FiCheckCircle, FiUpload, FiCamera, FiImage, FiX } from 'react-icons/fi';
import Modal from './Modal';
import api from '../api';
import toast from 'react-hot-toast';

export default function AjmerStickerPasteModal({ isOpen, onClose, tool, onSaved }) {
  const [photoUrl, setPhotoUrl] = useState(tool?.sticker_photo_url || '');
  const [condition, setCondition] = useState(tool?.condition || 'good');
  const [notes, setNotes] = useState(tool?.sticker_notes || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!isOpen || !tool) return null;

  const handleUploadPhoto = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Please choose an image file (JPG, PNG)');
    if (file.size > 8 * 1024 * 1024) return toast.error('Photo must be under 8 MB');

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/upload?folder=tools', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setPhotoUrl(data.url);
      toast.success('Sticker photo uploaded! Save to verify.');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to upload photo');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!photoUrl) {
      return toast.error('Please upload a photo showing the sticker pasted on the tool/machine');
    }

    setSaving(true);
    try {
      await api.post(`/tools/${tool.id}/sticker-pasted`, {
        photo_url: photoUrl,
        condition,
        notes
      });
      toast.success(`Sticker verified with photo for ${tool.tool_code}!`);
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save sticker confirmation');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Ajmer Physical Sticker Verification: ${tool.tool_code}`}
      wide
    >
      <form onSubmit={handleSave} className="space-y-4">
        {/* Tool Info Banner */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 text-xs">
          <div>
            <div className="font-bold text-slate-800 text-sm">{tool.name}</div>
            <div className="text-slate-500">
              Make: <strong className="text-slate-700">{tool.brand || tool.make || 'SEPL'}</strong> · Barcode: <span className="font-mono">{tool.barcode || tool.tool_code}</span>
            </div>
          </div>
          <div className="text-right">
            <span className="inline-block px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-100 text-blue-800">
              📍 {tool.current_site_name || 'SEPL Godown'}
            </span>
          </div>
        </div>

        {/* Ajmer Instruction Alert */}
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 leading-relaxed">
          <strong>Ajmer Sir Verification Guideline:</strong> Ensure the TVS barcode sticker is firmly pasted on the metal/body of the tool (or godown machine). Take a clear photo showing the sticker and machine number clearly.
        </div>

        {/* Photo Upload Area */}
        <div className="border-2 border-dashed border-slate-300 rounded-2xl p-5 text-center bg-slate-50 hover:bg-slate-100/80 transition-colors">
          {photoUrl ? (
            <div className="space-y-3">
              <div className="relative inline-block">
                <img
                  src={photoUrl}
                  alt="Sticker Pasted Proof"
                  className="max-h-64 rounded-xl border border-slate-300 shadow-sm mx-auto object-cover"
                />
                <button
                  type="button"
                  onClick={() => setPhotoUrl('')}
                  className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full p-1 shadow-md hover:bg-red-700"
                  title="Remove photo"
                >
                  <FiX size={14} />
                </button>
              </div>
              <p className="text-xs text-emerald-700 font-semibold flex items-center justify-center gap-1">
                <FiCheckCircle /> Physical Sticker Photo Attached
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto">
                <FiCamera size={24} />
              </div>
              <div className="text-sm font-semibold text-slate-800">
                Upload Photo of Sticker on Machine
              </div>
              <p className="text-xs text-slate-500">
                Snap photo from mobile camera or pick image file (PNG / JPG up to 8 MB)
              </p>
              <label className="btn btn-secondary inline-flex items-center gap-2 cursor-pointer mt-2 text-xs">
                <FiUpload size={14} />
                {uploading ? 'Uploading…' : 'Take Photo / Browse File'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  disabled={uploading}
                  onChange={e => {
                    handleUploadPhoto(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          )}
        </div>

        {/* Condition & Notes */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <label className="label">Tool / Machine Condition *</label>
            <select
              value={condition}
              onChange={e => setCondition(e.target.value)}
              className="select"
            >
              <option value="new">New (Unused / Fresh)</option>
              <option value="good">Good (Working fine)</option>
              <option value="fair">Fair (Normal wear & tear)</option>
              <option value="poor">Poor (Requires attention / service)</option>
              <option value="scrap">Scrap (Non-repairable)</option>
            </select>
          </div>
          <div>
            <label className="label">Pasting Location & Notes</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Pasted near nameplate on motor body, tested ok"
              className="input"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-3 border-t">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !photoUrl}
            className="btn btn-primary flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50"
          >
            <FiCheckCircle size={15} />
            {saving ? 'Saving Verification…' : 'Verify & Mark Pasted (Ajmer)'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

