import { useState, useEffect, useRef } from 'react';
import { EFFORT_COLORS } from '../utils.js';

const DEFAULT_FILTERS = {
  search: '', efforts: [], statuses: [], modelId: '', hasPlan: false, dateFrom: '', dateTo: '',
};

const STATUS_OPTIONS = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'planning', label: 'Planning' },
  { value: 'planned', label: 'Planned' },
  { value: 'queued', label: 'Queued' },
  { value: 'executing', label: 'Executing' },
  { value: 'done', label: 'Done' },
];

const EFFORT_OPTIONS = ['small', 'medium', 'large'];

function countActiveFilters(filters) {
  let count = 0;
  if (filters.search) count++;
  if (filters.efforts.length) count++;
  if (filters.statuses.length) count++;
  if (filters.modelId) count++;
  if (filters.hasPlan) count++;
  if (filters.dateFrom) count++;
  if (filters.dateTo) count++;
  return count;
}

export default function FilterBar({ filters, onFiltersChange, models }) {
  const [searchInput, setSearchInput] = useState(filters.search);
  const debounceRef = useRef(null);

  // Sync local input when filters change externally (e.g. clear all, project switch)
  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);

  const handleSearchChange = (value) => {
    setSearchInput(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onFiltersChange({ ...filters, search: value });
    }, 300);
  };

  const toggleEffort = (effort) => {
    const next = filters.efforts.includes(effort)
      ? filters.efforts.filter((e) => e !== effort)
      : [...filters.efforts, effort];
    onFiltersChange({ ...filters, efforts: next });
  };

  const toggleStatus = (status) => {
    const next = filters.statuses.includes(status)
      ? filters.statuses.filter((s) => s !== status)
      : [...filters.statuses, status];
    onFiltersChange({ ...filters, statuses: next });
  };

  const activeCount = countActiveFilters(filters);

  return (
    <div className="filter-bar">
      {/* Text search */}
      <div className="filter-search">
        <svg className="filter-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          className="filter-search-input"
          type="text"
          placeholder="Search tasks..."
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
        {searchInput && (
          <button className="filter-search-clear" onClick={() => handleSearchChange('')}>&times;</button>
        )}
      </div>

      <div className="filter-divider" />

      {/* Effort filter */}
      <div className="filter-group">
        <span className="filter-label">Effort</span>
        {EFFORT_OPTIONS.map((e) => (
          <button
            key={e}
            className={`filter-toggle${filters.efforts.includes(e) ? ' active' : ''}`}
            style={filters.efforts.includes(e) ? { background: EFFORT_COLORS[e], borderColor: EFFORT_COLORS[e], color: '#0f1117' } : undefined}
            onClick={() => toggleEffort(e)}
          >
            {e.charAt(0).toUpperCase() + e.slice(1)}
          </button>
        ))}
      </div>

      <div className="filter-divider" />

      {/* Status filter */}
      <div className="filter-group">
        <span className="filter-label">Status</span>
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s.value}
            className={`filter-toggle${filters.statuses.includes(s.value) ? ' active' : ''}`}
            onClick={() => toggleStatus(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="filter-divider" />

      {/* Model filter */}
      {models.length > 0 && (
        <>
          <div className="filter-group">
            <span className="filter-label">Model</span>
            <select
              className="filter-select"
              value={filters.modelId}
              onChange={(e) => onFiltersChange({ ...filters, modelId: e.target.value })}
            >
              <option value="">All</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="filter-divider" />
        </>
      )}

      {/* Has Plan toggle */}
      <button
        className={`filter-toggle${filters.hasPlan ? ' active' : ''}`}
        onClick={() => onFiltersChange({ ...filters, hasPlan: !filters.hasPlan })}
      >
        Has Plan
      </button>

      <div className="filter-divider" />

      {/* Date range */}
      <div className="filter-group">
        <span className="filter-label">Date</span>
        <input
          type="date"
          className="filter-date"
          value={filters.dateFrom}
          onChange={(e) => onFiltersChange({ ...filters, dateFrom: e.target.value })}
        />
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>&ndash;</span>
        <input
          type="date"
          className="filter-date"
          value={filters.dateTo}
          onChange={(e) => onFiltersChange({ ...filters, dateTo: e.target.value })}
        />
      </div>

      {/* Active count + Clear */}
      {activeCount > 0 && (
        <>
          <div className="filter-divider" />
          <span className="filter-active-count">{activeCount} active</span>
          <button
            className="filter-clear-all"
            onClick={() => {
              onFiltersChange({ ...DEFAULT_FILTERS });
              setSearchInput('');
            }}
          >
            Clear all
          </button>
        </>
      )}
    </div>
  );
}
