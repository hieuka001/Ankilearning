import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Cell
} from 'recharts';

interface AssessmentResultChartProps {
  score: number;
  total: number;
}

export default function AssessmentResultChart({ score, total }: AssessmentResultChartProps) {
  const data = [
    { name: 'Đúng', value: score, color: '#10b981' },
    { name: 'Sai', value: total - score, color: '#ef4444' }
  ];

  return (
    <div className="w-full h-48 md:h-64" style={{ minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
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
      </ResponsiveContainer>
    </div>
  );
}
