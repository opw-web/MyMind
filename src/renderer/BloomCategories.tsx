import {useState} from 'react';
import {COLORS, type ActionPreviewTarget, type Category, type Change} from '../shared/model';
import {Icon} from './App';
import {previewClass} from './BloomControls';

interface Props {
  categories: Category[];
  hidden: ReadonlySet<string>;
  target: ActionPreviewTarget | null;
  busy: boolean;
  setVisibility: (id: string, visible: boolean) => void;
  showAll: () => void;
  save: (changes: Change[], label: string) => Promise<boolean>;
}

export default function BloomCategories({categories, hidden, target, busy, setVisibility, showAll, save}: Props) {
  const [editing, setEditing] = useState<{id: string; title: string} | null>(null);
  const [newName, setNewName] = useState('');
  const ghost = target?.entity === 'category' && target.before && !categories.some(category => category.id === target.id)
    ? {...target.before, id: target.id} as unknown as Category : null;
  const listed = ghost ? [...categories, ghost] : categories;

  async function rename(category: Category) {
    if (!editing || editing.id !== category.id) return;
    const current = editing;
    const title = current.title.trim();
    if (!title || title === category.title || await save([{entity: 'category', action: 'update', id: category.id, fields: {title}}], 'Category renamed')) {
      setEditing(value => value === current ? null : value);
    }
  }

  async function add() {
    const title = newName.trim();
    if (!title) return;
    const color = COLORS[categories.length % COLORS.length];
    if (await save([{entity: 'category', action: 'create', fields: {title, color}}], 'Category added')) {
      setNewName(value => value === newName ? '' : value);
    }
  }

  return <div className="category-popover" aria-label="Calendar categories">
    <div className="pop-title"><span>CATEGORIES</span><button type="button" onClick={showAll}>Show all</button></div>
    <div className="category-list">
      {listed.map(category => {
        const editor = editing?.id === category.id ? editing : null;
        const deleted = ghost?.id === category.id;
        return <div key={category.id} data-category-id={category.id} className={'cat-pop-row' + previewClass(target, 'category', category.id)}>
          <label className="cat-pick">
            <input type="checkbox" checked={!hidden.has(category.id)} disabled={deleted} aria-label={`Show ${category.title}`}
              onChange={event => setVisibility(category.id, event.target.checked)}/>
            <span className={`category-dot color-${category.color}`}/>
          </label>
          {editor ? <input className="cat-inline-input" autoFocus aria-label="Category name" value={editor.title}
            onChange={event => setEditing({...editor, title: event.target.value})} onKeyDown={event => {
              if (event.key === 'Enter') {event.preventDefault(); void rename(category);}
            }}/> : <span className="cat-name">{category.title}</span>}
          <button type="button" className="cat-mini-btn" title={editor ? 'Save name' : 'Rename category'}
            aria-label={editor ? 'Save name' : `Rename category: ${category.title}`} disabled={busy || deleted}
            onClick={() => editor ? void rename(category) : setEditing({id: category.id, title: category.title})}>
            <Icon name={editor ? 'check' : 'edit'} size={14}/>
          </button>
        </div>;
      })}
    </div>
    <form className="cat-add-row" onSubmit={event => {event.preventDefault(); void add();}}>
      <input placeholder="New category name" aria-label="New category name" value={newName} onChange={event => setNewName(event.target.value)}/>
      <button type="submit" aria-label="Add category" className="small-add-btn" disabled={busy || !newName.trim()}><Icon name="plus" size={16}/></button>
    </form>
  </div>;
}
