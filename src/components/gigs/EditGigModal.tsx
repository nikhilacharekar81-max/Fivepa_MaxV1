import React from 'react';
import { Trash2, AlertCircle } from 'lucide-react';
import { Gig, Category } from '../../types';
import { BaseModal } from '../ui/BaseModal';

interface EditGigModalProps {
  editingGig: Gig | null;
  categories: Category[];
  onClose: () => void;
  onSave: (e: React.FormEvent) => void;
  onDelete: (id: string) => void;
  errorMessage?: string | null;
  isSaving?: boolean;
  minPrice?: number;
  maxPrice?: number;
}

export const EditGigModal: React.FC<EditGigModalProps> = ({
  editingGig,
  categories,
  onClose,
  onSave,
  onDelete,
  errorMessage,
  isSaving = false,
  minPrice = 5,
  maxPrice = 10000
}) => {
  if (!editingGig) return null;

  return (
    <BaseModal 
      isOpen={!!editingGig}
      onClose={onClose}
      title={`Edit Service — ${editingGig.title}`}
      maxWidth="max-w-xl"
    >
      <form onSubmit={onSave} className="space-y-4 text-xs">
        {errorMessage && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2 font-medium">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div>
          <label className="block text-fiverr-dark font-bold uppercase mb-1">Gig Title</label>
          <input 
            type="text" 
            name="title"
            defaultValue={editingGig.title}
            required
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-fiverr-dark focus:outline-none focus:bg-white focus:border-emerald-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-fiverr-dark font-bold uppercase mb-1">Category</label>
            <select 
              name="category"
              defaultValue={editingGig.category}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-fiverr-dark focus:outline-none focus:bg-white focus:border-emerald-500"
            >
              {categories.map(c => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-fiverr-dark font-bold uppercase mb-1">Subcategory</label>
            <input 
              type="text" 
              name="subcategory"
              defaultValue={editingGig.subcategory || ''}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-fiverr-dark focus:outline-none focus:bg-white focus:border-emerald-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-fiverr-dark font-bold uppercase mb-1">
              Starting Price ($ USD, ${minPrice}–${maxPrice.toLocaleString()})
            </label>
            <input 
              type="number" 
              name="price"
              min={minPrice}
              max={maxPrice}
              step="0.01"
              defaultValue={editingGig.price}
              required
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-fiverr-dark focus:outline-none focus:bg-white focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="block text-fiverr-dark font-bold uppercase mb-1">Delivery Time (Days)</label>
            <input 
              type="number" 
              name="deliveryDays"
              min={1}
              max={365}
              step="1"
              defaultValue={editingGig.deliveryDays}
              required
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-fiverr-dark focus:outline-none focus:bg-white focus:border-emerald-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-fiverr-dark font-bold uppercase mb-1">Description</label>
          <textarea 
            rows={4}
            name="description"
            defaultValue={editingGig.description}
            required
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-fiverr-dark focus:outline-none focus:bg-white focus:border-emerald-500"
          />
        </div>

        <div className="pt-2">
          <label className="flex items-center gap-2 cursor-pointer font-bold text-fiverr-dark">
            <input 
              type="checkbox" 
              name="featured"
              defaultChecked={editingGig.featured}
              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
            />
            <span>Feature Gig on Homepage & Listings</span>
          </label>
        </div>

        <div className="pt-4 flex items-center justify-between border-t border-slate-100">
          <button 
            type="button"
            disabled={isSaving}
            onClick={() => onDelete(editingGig.id)}
            className="px-4 py-2 bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 font-bold rounded-xl flex items-center gap-1.5 text-xs transition-colors cursor-pointer disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            <span>Delete Service</span>
          </button>
          <div className="flex items-center gap-3">
            <button 
              type="button"
              disabled={isSaving}
              onClick={onClose}
              className="px-4 py-2 bg-slate-100 text-fiverr-dark font-bold rounded-xl hover:bg-slate-200 text-xs cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button 
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-500 text-xs shadow-xs cursor-pointer disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save Gig Details'}
            </button>
          </div>
        </div>
      </form>
    </BaseModal>
  );
};
