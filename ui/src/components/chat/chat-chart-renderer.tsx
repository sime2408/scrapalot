import React from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { ChartDataPacket } from '@/types/streaming-packets';
import { useTheme } from '@/providers/theme-provider';

const DEFAULT_COLORS = [
  '#4f81bd', '#c0504d', '#9bbb59', '#8064a2',
  '#4bacc6', '#f79646', '#2c4770', '#7f1919',
];

interface ChatChartRendererProps {
  packet: ChartDataPacket;
}

export const ChatChartRenderer: React.FC<ChatChartRendererProps> = ({ packet }) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const axisColor = isDark ? '#9ca3af' : '#6b7280';
  const gridColor = isDark ? '#374151' : '#e5e7eb';
  const bgColor = isDark ? '#1f2937' : '#f9fafb';

  const datasets = React.useMemo(
    () => Array.isArray(packet.datasets) ? packet.datasets : [],
    [packet.datasets]
  );

  // Build Recharts data array for bar/line: [{name: label, Series1: val, ...}, ...]
  const barLineData = React.useMemo(() => {
    if (!packet.labels || packet.labels.length === 0) return [];
    return packet.labels.map((label, i) => {
      const entry: Record<string, string | number> = { name: label };
      datasets.forEach((ds) => {
        const val = Array.isArray(ds.data) ? ds.data[i] : undefined;
        if (typeof val === 'number') {
          entry[ds.label] = val;
        }
      });
      return entry;
    });
  }, [packet.labels, datasets]);

  // Pie data: use first dataset, items may be {name, value} or numbers mapped to labels.
  // LLM sometimes sends flat [{name, value}, ...] as datasets instead of [{label, data: [...]}].
  const pieData = React.useMemo(() => {
    const ds = datasets[0];
    if (!ds) return [];

    // Normal format: dataset has a data array
    if (Array.isArray(ds.data)) {
      if (ds.data.length > 0 && typeof ds.data[0] === 'object' && 'name' in (ds.data[0] as object)) {
        return ds.data as Array<{ name: string; value: number }>;
      }
      return (ds.data as number[]).map((val, i) => ({
        name: packet.labels?.[i] || `Item ${i + 1}`,
        value: val,
      }));
    }

    // Flat format: each dataset item IS a data point {name, value}
    if ('name' in ds && 'value' in ds) {
      return datasets as unknown as Array<{ name: string; value: number }>;
    }

    return [];
  }, [datasets, packet.labels]);

  // Scatter data: flatten all datasets into points
  const scatterPoints = React.useMemo(() => {
    return datasets.map((ds) => ({
      name: ds.label,
      color: ds.color,
      data: Array.isArray(ds.data)
        ? (ds.data as Array<{ x: number; y: number }>).filter(
            (d) => typeof d === 'object' && 'x' in d && 'y' in d
          )
        : [],
    }));
  }, [datasets]);

  const renderChart = () => {
    switch (packet.chart_type) {
      case 'bar':
        return (
          <BarChart data={barLineData}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
            <XAxis dataKey="name" tick={{ fill: axisColor, fontSize: 11 }} label={packet.x_label ? { value: packet.x_label, position: 'insideBottom', offset: -5, fill: axisColor } : undefined} />
            <YAxis tick={{ fill: axisColor, fontSize: 11 }} label={packet.y_label ? { value: packet.y_label, angle: -90, position: 'insideLeft', fill: axisColor } : undefined} />
            <Tooltip contentStyle={{ background: bgColor, border: `1px solid ${gridColor}`, borderRadius: 0 }} />
            <Legend wrapperStyle={{ color: axisColor }} />
            {datasets.map((ds, i) => (
              <Bar key={ds.label} dataKey={ds.label} fill={ds.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
            ))}
          </BarChart>
        );

      case 'line':
        return (
          <LineChart data={barLineData}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
            <XAxis dataKey="name" tick={{ fill: axisColor, fontSize: 11 }} label={packet.x_label ? { value: packet.x_label, position: 'insideBottom', offset: -5, fill: axisColor } : undefined} />
            <YAxis tick={{ fill: axisColor, fontSize: 11 }} label={packet.y_label ? { value: packet.y_label, angle: -90, position: 'insideLeft', fill: axisColor } : undefined} />
            <Tooltip contentStyle={{ background: bgColor, border: `1px solid ${gridColor}`, borderRadius: 0 }} />
            <Legend wrapperStyle={{ color: axisColor }} />
            {datasets.map((ds, i) => (
              <Line
                key={ds.label}
                type="monotone"
                dataKey={ds.label}
                stroke={ds.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
                dot={barLineData.length <= 20}
                strokeWidth={2}
              />
            ))}
          </LineChart>
        );

      case 'pie':
        return (
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              outerRadius={110}
              dataKey="value"
              label={({ name, percent }) => `${name} (${(percent * 100).toFixed(1)}%)`}
              labelLine={{ stroke: axisColor }}
            >
              {pieData.map((_, i) => (
                <Cell
                  key={i}
                  fill={DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
                />
              ))}
            </Pie>
            <Tooltip contentStyle={{ background: bgColor, border: `1px solid ${gridColor}`, borderRadius: 0 }} />
            <Legend wrapperStyle={{ color: axisColor }} />
          </PieChart>
        );

      case 'scatter':
        return (
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
            <XAxis dataKey="x" type="number" name={packet.x_label || 'X'} tick={{ fill: axisColor, fontSize: 11 }} label={packet.x_label ? { value: packet.x_label, position: 'insideBottom', offset: -5, fill: axisColor } : undefined} />
            <YAxis dataKey="y" type="number" name={packet.y_label || 'Y'} tick={{ fill: axisColor, fontSize: 11 }} label={packet.y_label ? { value: packet.y_label, angle: -90, position: 'insideLeft', fill: axisColor } : undefined} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: bgColor, border: `1px solid ${gridColor}`, borderRadius: 0 }} />
            <Legend wrapperStyle={{ color: axisColor }} />
            {scatterPoints.map((s, i) => (
              <Scatter
                key={s.name}
                name={s.name}
                data={s.data}
                fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              />
            ))}
          </ScatterChart>
        );

      default:
        return null;
    }
  };

  return (
    <div className="mt-3 border border-border bg-card p-3">
      {packet.title && (
        <p className="text-sm font-medium text-foreground mb-2">{packet.title}</p>
      )}
      <ResponsiveContainer width="100%" height={280}>
        {renderChart() ?? <div />}
      </ResponsiveContainer>
    </div>
  );
};
