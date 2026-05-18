import { useLayoutEffect, useRef, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell
} from 'recharts';

interface AssessmentResultChartProps {
  score: number;
  total: number;
}

export default function AssessmentResultChart({ score, total }: AssessmentResultChartProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const data = [
    { name: 'Đúng', value: score, color: '#10b981' },
    { name: 'Sai', value: total - score, color: '#ef4444' }
  ];

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

  const canRenderChart = size.width > 0 && size.height > 0;

  return (
    <div ref={frameRef} className="h-48 w-full min-w-0 md:h-64">
      {canRenderChart ? (
        <BarChart width={size.width} height={size.height} data={data} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="rgba(255,255,255,0.05)" />
          <XAxis type="number" hide />
          <YAxis
            dataKey="name"
            type="category"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 12, fontWeight: 700, fill: '#64748b' }}
          />
          <Tooltip
            cursor={{ fill: 'transparent' }}
            contentStyle={{
              backgroundColor: '#0C0D0E',
              borderRadius: '0.75rem',
              border: '1px solid rgba(255,255,255,0.1)',
              fontWeight: 700
            }}
          />
          <Bar dataKey="value" radius={[0, 10, 10, 0]} barSize={40}>
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      ) : (
        <div className="h-full animate-pulse rounded-lg bg-black/[0.04] dark:bg-white/[0.06]" />
      )}
    </div>
  );
}
