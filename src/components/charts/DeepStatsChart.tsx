import {
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLayoutEffect, useRef, useState } from 'react';

interface DeepStatsChartProps {
  data: Array<{
    label: string;
    count: number;
  }>;
}

/**
 * Bar chart of review counts per day for the deep-stats section. Follows
 * the DashboardChart pattern (explicit pixel size via ResizeObserver —
 * ResponsiveContainer mis-measured inside the dashboard cards).
 */
export default function DeepStatsChart({ data }: DeepStatsChartProps) {
  const total = data?.reduce((sum, item) => sum + item.count, 0) || 0;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const updateSize = () => {
      const rect = frame.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      setSize((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ));
    };

    updateSize();
    const animationFrame = window.requestAnimationFrame(updateSize);

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize);
      return () => {
        window.cancelAnimationFrame(animationFrame);
        window.removeEventListener('resize', updateSize);
      };
    }

    const observer = new ResizeObserver(updateSize);
    observer.observe(frame);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, []);

  if (!data || data.length === 0 || total === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-black/[0.08] bg-white/[0.45] text-sm text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
        Chưa có lượt ôn nào trong 30 ngày gần nhất.
      </div>
    );
  }

  const canRenderChart = size.width > 0 && size.height > 0;

  return (
    <div ref={frameRef} className="h-full min-h-[240px] w-full min-w-0">
      {canRenderChart ? (
        <BarChart width={size.width} height={size.height} data={data} margin={{ top: 10, right: 18, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(20,20,22,0.07)" strokeDasharray="4 8" vertical={false} />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            dy={12}
            interval={4}
            tick={{ fontSize: 10, fontWeight: 500, fill: '#71717A' }}
          />
          <YAxis hide domain={[0, 'dataMax + 2']} />
          <Tooltip
            cursor={{ fill: 'rgba(16,185,129,0.08)' }}
            contentStyle={{
              backgroundColor: 'rgba(255,255,255,0.96)',
              border: '1px solid rgba(20,20,22,0.08)',
              borderRadius: 8,
              boxShadow: '0 18px 42px rgba(20,20,22,0.12)',
              color: '#141416',
              fontSize: 12,
              fontWeight: 600,
            }}
            itemStyle={{ color: '#059669' }}
            labelStyle={{ color: '#71717A', fontWeight: 500 }}
            formatter={(value) => [`${value} lượt ôn`, '']}
            labelFormatter={(label) => `Ngày ${label}`}
          />
          <Bar
            dataKey="count"
            name="Lượt ôn"
            fill="#10B981"
            radius={[4, 4, 0, 0]}
            maxBarSize={18}
            animationDuration={700}
          />
        </BarChart>
      ) : (
        <div className="h-full min-h-[240px] animate-pulse rounded-lg bg-black/[0.04] dark:bg-white/[0.06]" />
      )}
    </div>
  );
}
