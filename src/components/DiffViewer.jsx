import { useState, memo } from 'react';

function parseDiff(raw) {
  const files = [];
  if (!raw) return files;

  const fileChunks = raw.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    const headerMatch = lines[0].match(/a\/(.+?)\s+b\/(.+)/);
    const filename = headerMatch ? headerMatch[2] : lines[0];

    let additions = 0;
    let deletions = 0;
    const hunks = [];
    let currentHunk = null;
    let isBinary = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('Binary files')) {
        isBinary = true;
        continue;
      }

      if (line.startsWith('@@')) {
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = { header: line, lines: [] };
      } else if (currentHunk) {
        if (line.startsWith('+')) {
          additions++;
          currentHunk.lines.push({ type: 'addition', content: line.slice(1) });
        } else if (line.startsWith('-')) {
          deletions++;
          currentHunk.lines.push({ type: 'deletion', content: line.slice(1) });
        } else if (line.startsWith(' ') || line === '') {
          currentHunk.lines.push({ type: 'context', content: line.slice(1) || '' });
        }
      }
    }
    if (currentHunk) hunks.push(currentHunk);

    files.push({ filename, additions, deletions, hunks, isBinary });
  }

  return files;
}

function DiffViewer({ diff, commitHash, onCopy, onRevert }) {
  const files = parseDiff(diff);
  const [expandedFiles, setExpandedFiles] = useState(
    () => new Set(files.map(f => f.filename))
  );
  const [copied, setCopied] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState(false);

  const toggleFile = (filename) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const handleCopy = () => {
    onCopy?.();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevert = () => {
    if (!revertConfirm) {
      setRevertConfirm(true);
      setTimeout(() => setRevertConfirm(false), 3000);
      return;
    }
    setRevertConfirm(false);
    onRevert?.();
  };

  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="diff-viewer">
      <div className="diff-toolbar">
        <span className="diff-stats">
          {files.length} file{files.length !== 1 ? 's' : ''} changed{' '}
          <span className="diff-additions">+{totalAdditions}</span>{' '}
          <span className="diff-deletions">-{totalDeletions}</span>
        </span>
        <div className="diff-toolbar-actions">
          <button className="btn btn-sm btn-copy-diff" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy Diff'}
          </button>
          {onRevert && (
            <button
              className={`btn btn-sm btn-revert${revertConfirm ? ' confirming' : ''}`}
              onClick={handleRevert}
            >
              {revertConfirm ? 'Are you sure?' : 'Revert Commit'}
            </button>
          )}
        </div>
      </div>

      {files.map((file) => (
        <div key={file.filename} className="diff-file">
          <div
            className="diff-file-header"
            onClick={() => toggleFile(file.filename)}
          >
            <span className="diff-file-toggle">
              {expandedFiles.has(file.filename) ? '\u25BC' : '\u25B6'}
            </span>
            <span className="diff-file-name">{file.filename}</span>
            <span className="diff-file-stats">
              <span className="diff-additions">+{file.additions}</span>{' '}
              <span className="diff-deletions">-{file.deletions}</span>
            </span>
          </div>

          {expandedFiles.has(file.filename) && (
            <div className="diff-file-content">
              {file.isBinary && (
                <div className="diff-binary">Binary file changed</div>
              )}
              {file.hunks.map((hunk, hi) => (
                <div key={hi} className="diff-hunk">
                  <div className="diff-hunk-header">{hunk.header}</div>
                  {hunk.lines.map((line, li) => (
                    <div key={li} className={`diff-line diff-line-${line.type}`}>
                      <span className="diff-line-prefix">
                        {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
                      </span>
                      <span className="diff-line-content">{line.content}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default memo(DiffViewer);
