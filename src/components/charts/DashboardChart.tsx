import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface DashboardChartProps {
  data: Array<{
    date: string;
    count: number;
  }>;
}

export default function DashboardChart({ data }: DashboardChartProps) {
  const total = data?.reduce((sum, item) => sum + item.count, 0) || 0;

  if (!data || data.length === 0 || total === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-black/[0.08] bg-white/[0.45] text-sm text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
        Chưa có dữ liệu xu hướng trong 7 ngày gần đây.
      </div>
    );
  }

  return (
    <div className="h-full w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <AreaChart data={data} margin={{ top: 10, right: 18, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="learningCardTrend" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563EB" stopOpacity={0.22} />
              <stop offset="80%" stopColor="#2563EB" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(20,20,22,0.07)" strokeDasharray="4 8" vertical={false} />
          <XAxis
            dataKey="date"
            axisLine={false}
            tickLine={false}
            dy={12}
            tick={{ fontSize: 11, fontWeight: 500, fill: '#71717A' }}
          />
          <YAxis hide domain={[0, 'dataMax + 4']} />
          <Tooltip
            cursor={{ stroke: 'rgba(37,99,235,0.22)', strokeWidth: 1 }}
            contentStyle={{
              backgroundColor: 'rgba(255,255,255,0.96)',
              border: '1px solid rgba(20,20,22,0.08)',
              borderRadius: 8,
              boxShadow: '0 18px 42px rgba(20,20,22,0.12)',
              color: '#141416',
              fontSize: 12,
              fontWeight: 600,
            }}
            itemStyle={{ color: '#2563EB' }}
            labelStyle={{ color: '#71717A', fontWeight: 500 }}
          />
          <Area
            type="monotone"
            dataKey="count"
            name="Thẻ đã học"
            stroke="#2563EB"
            strokeWidth={2.5}
            fill="url(#learningCardTrend)"
            fillOpacity={1}
            animationDuration={900}
            activeDot={{ r: 4, strokeWidth: 3, stroke: '#FFFFFF', fill: '#2563EB' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
