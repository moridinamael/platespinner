import { memo, useMemo } from 'react';

const NODE_W = 150;
const NODE_H = 36;
const LAYER_GAP = 60;
const NODE_GAP = 16;
const PADDING = 20;

const STATUS_COLORS = {
  proposed: 'var(--text-dim)',
  planned: 'var(--blue)',
  planning: 'var(--blue)',
  queued: 'var(--text-dim)',
  executing: 'var(--yellow)',
  done: 'var(--green)',
  failed: 'var(--red)',
};

function DependencyGraph({ tasks, focusTaskId }) {
  const { nodes, edges, width, height } = useMemo(() => {
    if (!tasks || tasks.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

    // Build a set of task IDs that participate in dependency relationships
    const depSet = new Set();
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    for (const t of tasks) {
      if (t.dependencies && t.dependencies.length > 0) {
        depSet.add(t.id);
        for (const d of t.dependencies) {
          if (taskMap.has(d)) depSet.add(d);
        }
      }
    }

    // Always include the focus task
    if (focusTaskId && taskMap.has(focusTaskId)) depSet.add(focusTaskId);

    // Also include tasks that depend on depSet members
    for (const t of tasks) {
      if (t.dependencies) {
        for (const d of t.dependencies) {
          if (depSet.has(d)) depSet.add(t.id);
        }
      }
    }

    if (depSet.size === 0) return { nodes: [], edges: [], width: 0, height: 0 };

    const relevantTasks = tasks.filter(t => depSet.has(t.id));

    // Compute depth (layer) via topological sort — longest path from root
    const depth = new Map();
    const computeDepth = (id, visited) => {
      if (depth.has(id)) return depth.get(id);
      if (visited.has(id)) return 0; // cycle guard
      visited.add(id);
      const t = taskMap.get(id);
      if (!t || !t.dependencies || t.dependencies.length === 0) {
        depth.set(id, 0);
        return 0;
      }
      let maxDep = 0;
      for (const d of t.dependencies) {
        if (taskMap.has(d)) {
          maxDep = Math.max(maxDep, computeDepth(d, visited) + 1);
        }
      }
      depth.set(id, maxDep);
      return maxDep;
    };

    for (const t of relevantTasks) {
      computeDepth(t.id, new Set());
    }

    // Group by layer
    const layers = new Map();
    for (const t of relevantTasks) {
      const d = depth.get(t.id) || 0;
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d).push(t);
    }

    const maxLayer = Math.max(...layers.keys());
    const maxNodesInLayer = Math.max(...[...layers.values()].map(l => l.length));

    const svgWidth = maxNodesInLayer * (NODE_W + NODE_GAP) - NODE_GAP + PADDING * 2;
    const svgHeight = (maxLayer + 1) * (NODE_H + LAYER_GAP) - LAYER_GAP + PADDING * 2;

    // Assign positions
    const nodePositions = new Map();
    for (let layer = 0; layer <= maxLayer; layer++) {
      const layerTasks = layers.get(layer) || [];
      const totalWidth = layerTasks.length * (NODE_W + NODE_GAP) - NODE_GAP;
      const startX = (svgWidth - totalWidth) / 2;
      layerTasks.forEach((t, i) => {
        nodePositions.set(t.id, {
          x: startX + i * (NODE_W + NODE_GAP),
          y: PADDING + layer * (NODE_H + LAYER_GAP),
        });
      });
    }

    const graphNodes = relevantTasks.map(t => ({
      id: t.id,
      title: t.title.length > 20 ? t.title.slice(0, 18) + '...' : t.title,
      status: t.status,
      isFocus: t.id === focusTaskId,
      ...nodePositions.get(t.id),
    }));

    const graphEdges = [];
    for (const t of relevantTasks) {
      if (!t.dependencies) continue;
      for (const depId of t.dependencies) {
        const from = nodePositions.get(depId);
        const to = nodePositions.get(t.id);
        if (from && to) {
          graphEdges.push({
            fromId: depId,
            toId: t.id,
            x1: from.x + NODE_W / 2,
            y1: from.y + NODE_H,
            x2: to.x + NODE_W / 2,
            y2: to.y,
          });
        }
      }
    }

    return { nodes: graphNodes, edges: graphEdges, width: svgWidth, height: svgHeight };
  }, [tasks, focusTaskId]);

  if (nodes.length === 0) return null;

  return (
    <div className="dependency-graph-container">
      <svg className="dependency-graph" width={width} height={height}>
        <defs>
          <marker id="dep-arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="var(--text-dim)" />
          </marker>
        </defs>
        {edges.map((e, i) => (
          <line
            key={i}
            x1={e.x1} y1={e.y1}
            x2={e.x2} y2={e.y2}
            stroke="var(--text-dim)"
            strokeWidth="1.5"
            markerEnd="url(#dep-arrowhead)"
            opacity="0.6"
          />
        ))}
        {nodes.map(n => (
          <g key={n.id}>
            <rect
              x={n.x} y={n.y}
              width={NODE_W} height={NODE_H}
              rx="6" ry="6"
              fill={n.isFocus ? 'var(--bg-hover)' : 'var(--bg-card)'}
              stroke={STATUS_COLORS[n.status] || 'var(--text-dim)'}
              strokeWidth={n.isFocus ? 2.5 : 1.5}
            />
            <circle
              cx={n.x + 12} cy={n.y + NODE_H / 2}
              r="4"
              fill={STATUS_COLORS[n.status] || 'var(--text-dim)'}
            />
            <text
              x={n.x + 22} y={n.y + NODE_H / 2 + 4}
              fontSize="11"
              fill="var(--text)"
              style={{ pointerEvents: 'none' }}
            >
              {n.title}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default memo(DependencyGraph);
