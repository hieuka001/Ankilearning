import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';

interface DashboardChartProps {
  data: any[];
}

export default function DashboardChart({ data }: DashboardChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center text-[10px] font-black text-slate-400 uppercase tracking-widest">
        Chưa có dữ liệu xu hướng
      </div>
    );
  }

  return (
    <div className="w-full h-full min-h-[300px] px-6" style={{ minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <AreaChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#5E6AD2" stopOpacity={0.3}/>
              <stop offset="95%" stopColor="#5E6AD2" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
          <XAxis 
            dataKey="date" 
            axisLine={false} 
            tickLine={false} 
            tick={{ fontSize: 10, fontWeight: 700, fill: '#94a3b8' }}
            dy={10}
          />
          <YAxis hide />
          <Tooltip 
            contentStyle={{ 
              backgroundColor: '#0C0D0E', 
              borderRadius: '1rem', 
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)',
              fontWeight: 700
            }}
            itemStyle={{ color: '#5E6AD2' }}
          />
          <Area 
            type="monotone" 
            dataKey="count" 
            stroke="#5E6AD2" 
            strokeWidth={4}
            fillOpacity={1} 
            fill="url(#colorCount)" 
            animationDuration={2000}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
