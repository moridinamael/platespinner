import { useState, useEffect, useMemo } from 'react';
import { api } from '../api.js';
import { formatCost, formatTokens } from '../utils.js';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';

const CHART_COLORS = ['#6366f1', '#4ade80', '#a855f7', '#f97316', '#facc15', '#f87171', '#38bdf8', '#fb923c'];

const tooltipStyle = {
  contentStyle: { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: 12 },
  labelStyle: { color: 'var(--text)' },
  itemStyle: { color: 'var(--text-muted)' },
};

function Stat({ label, value }) {
  return (
    <div className="analytics-stat">
      <span className="analytics-stat-value">{value}</span>
      <span className="analytics-stat-label">{label}</span>
    </div>
  );
}

function EmptyCard({ title, message }) {
  return (
    <div className="analytics-card">
      <h3 className="analytics-card-title">{title}</h3>
      <div className="analytics-empty">{message || 'No data yet'}</div>
    </div>
  );
}

export default function AnalyticsDashboard({ selectedProjectId, projects, models, tasks }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getAnalytics(selectedProjectId).then(d => {
      if (!cancelled) { setData(d); setLoading(false); }
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedProjectId, tasks.length]);

  const getLabel = (modelId) => {
    const m = models.find(m => m.id === modelId);
    return m ? m.label : modelId;
  };

  // Prepare cost timeline with per-model columns for recharts
  const { costData, costModels } = useMemo(() => {
    if (!data?.costTimeline?.length) return { costData: [], costModels: [] };
    const modelSet = new Set();
    for (const d of data.costTimeline) {
      for (const m of Object.keys(d.byModel)) modelSet.add(m);
    }
    const costModels = [...modelSet];
    const costData = data.costTimeline.map(d => {
      const row = { date: d.date, total: d.total };
      for (const m of costModels) row[m] = d.byModel[m] || 0;
      return row;
    });
    return { costData, costModels };
  }, [data?.costTimeline]);

  // Model comparison data
  const modelComparisonData = useMemo(() => {
    if (!data?.modelStats) return [];
    return Object.entries(data.modelStats).map(([id, stats]) => ({
      name: getLabel(id),
      total: stats.total,
      done: stats.done,
      successRate: stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0,
      avgCost: stats.total > 0 ? stats.costTotal / stats.total : 0,
    }));
  }, [data?.modelStats, models]);

  // Token usage data for bar chart
  const tokenData = useMemo(() => {
    if (!data?.tokensByPhase) return [];
    return Object.entries(data.tokensByPhase)
      .filter(([, v]) => v.input > 0 || v.output > 0)
      .map(([phase, v]) => ({
        phase: phase.charAt(0).toUpperCase() + phase.slice(1),
        input: v.input,
        output: v.output,
      }));
  }, [data?.tokensByPhase]);

  // Autoclicker action distribution
  const autoclickerData = useMemo(() => {
    if (!data?.autoclicker?.actions) return [];
    return Object.entries(data.autoclicker.actions)
      .filter(([, v]) => v > 0)
      .map(([action, count]) => ({
        action: action.charAt(0).toUpperCase() + action.slice(1),
        count,
      }));
  }, [data?.autoclicker]);

  if (loading && !data) {
    return (
      <div className="analytics-dashboard">
        <div className="analytics-empty">Loading analytics...</div>
      </div>
    );
  }

  if (!data || data.totalTasks === 0) {
    return (
      <div className="analytics-dashboard">
        <div className="analytics-empty">No analytics data yet. Complete some tasks to see trends.</div>
      </div>
    );
  }

  return (
    <div className="analytics-dashboard">
      {/* Summary stats */}
      <div className="analytics-stats" style={{ marginBottom: 16 }}>
        <Stat label="Total Tasks" value={data.totalTasks} />
        <Stat label="Completed" value={data.statusCounts.done || 0} />
        <Stat label="Conversion" value={`${data.conversionRate.toFixed(1)}%`} />
        <Stat label="Total Cost" value={formatCost(data.totalCost)} />
      </div>

      <div className="analytics-grid">
        {/* 1. Cost Over Time */}
        {costData.length > 0 ? (
          <div className="analytics-card analytics-card-full">
            <h3 className="analytics-card-title">Cost Over Time</h3>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={costData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={v => `$${v.toFixed(2)}`} />
                <Tooltip {...tooltipStyle} formatter={(v) => formatCost(v)} />
                <Legend />
                {costModels.map((m, i) => (
                  <Line
                    key={m}
                    type="monotone"
                    dataKey={m}
                    name={getLabel(m)}
                    stroke={CHART_COLORS[i % CHART_COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyCard title="Cost Over Time" message="No cost data recorded yet" />
        )}

        {/* 2. Task Throughput */}
        {data.throughputTimeline.length > 0 ? (
          <div className="analytics-card">
            <h3 className="analytics-card-title">Task Throughput (Completed per Day)</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.throughputTimeline}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <Tooltip {...tooltipStyle} />
                <Bar dataKey="count" name="Completed" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyCard title="Task Throughput" message="No completed tasks yet" />
        )}

        {/* 3. Model Comparison */}
        {modelComparisonData.length > 0 ? (
          <div className="analytics-card">
            <h3 className="analytics-card-title">Model Comparison</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={modelComparisonData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <Tooltip {...tooltipStyle} />
                <Legend />
                <Bar dataKey="total" name="Total" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
                <Bar dataKey="done" name="Done" fill={CHART_COLORS[1]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="analytics-stats">
              {modelComparisonData.map(m => (
                <Stat key={m.name} label={m.name} value={`${m.successRate}% / ${formatCost(m.avgCost)}`} />
              ))}
            </div>
          </div>
        ) : (
          <EmptyCard title="Model Comparison" message="No model data yet" />
        )}

        {/* 4. Token Usage */}
        {tokenData.length > 0 ? (
          <div className="analytics-card">
            <h3 className="analytics-card-title">Token Usage by Phase</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={tokenData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="phase" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={v => formatTokens(v)} />
                <Tooltip {...tooltipStyle} formatter={(v) => formatTokens(v)} />
                <Legend />
                <Bar dataKey="input" name="Input" stackId="tokens" fill={CHART_COLORS[0]} />
                <Bar dataKey="output" name="Output" stackId="tokens" fill={CHART_COLORS[2]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="analytics-stats">
              {tokenData.map(d => (
                <Stat key={d.phase} label={d.phase} value={`${formatTokens(d.input + d.output)}`} />
              ))}
            </div>
          </div>
        ) : (
          <EmptyCard title="Token Usage" message="No token usage recorded" />
        )}

        {/* 5. Autoclicker Efficiency */}
        <div className="analytics-card">
          <h3 className="analytics-card-title">Autoclicker Efficiency</h3>
          {data.autoclicker.totalCycles > 0 ? (
            <>
              <div className="analytics-stats">
                <Stat label="Total Cycles" value={data.autoclicker.totalCycles} />
                <Stat label="Actions" value={data.autoclicker.actionfulCycles} />
                <Stat label="Skip Rate" value={data.autoclicker.totalCycles > 0 ? `${Math.round(data.autoclicker.actions.skip / data.autoclicker.totalCycles * 100)}%` : '0%'} />
                <Stat label="Cost/Action" value={formatCost(data.autoclicker.costPerAction)} />
                <Stat label="Total Cost" value={formatCost(data.autoclicker.totalCost)} />
              </div>
              {autoclickerData.length > 0 && (
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={autoclickerData}
                      dataKey="count"
                      nameKey="action"
                      cx="50%"
                      cy="50%"
                      outerRadius={70}
                      label={({ action, count }) => `${action}: ${count}`}
                    >
                      {autoclickerData.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip {...tooltipStyle} />
                  </PieChart>
                </ResponsiveContainer>
              )}
              {data.autoclicker.recentDecisions.length > 0 && (
                <div className="analytics-decisions">
                  <h4 className="analytics-card-title" style={{ fontSize: 12, marginBottom: 4 }}>Recent Decisions</h4>
                  {data.autoclicker.recentDecisions.slice(-10).reverse().map((d, i) => (
                    <div key={i} className="analytics-decision-row">
                      <span className="analytics-decision-action">{d.action}</span>
                      <span className="analytics-decision-reasoning">{d.reasoning}</span>
                      {d.costUsd > 0 && <span className="analytics-decision-cost">{formatCost(d.costUsd)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="analytics-empty">Autoclicker not yet used</div>
          )}
        </div>

        {/* 6. Cost by Effort */}
        {Object.values(data.costByEffort).some(e => e.count > 0) && (
          <div className="analytics-card">
            <h3 className="analytics-card-title">Cost by Effort</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={Object.entries(data.costByEffort).map(([effort, v]) => ({
                effort: effort.charAt(0).toUpperCase() + effort.slice(1),
                cost: v.cost,
                count: v.count,
                avg: v.count > 0 ? v.cost / v.count : 0,
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="effort" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={v => `$${v.toFixed(2)}`} />
                <Tooltip {...tooltipStyle} formatter={(v, name) => name === 'cost' || name === 'avg' ? formatCost(v) : v} />
                <Legend />
                <Bar dataKey="cost" name="Total Cost" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
                <Bar dataKey="avg" name="Avg Cost" fill={CHART_COLORS[2]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
