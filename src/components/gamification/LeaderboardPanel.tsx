import { motion } from 'motion/react';
import { Crown, Medal, TrendingUp, Trophy } from 'lucide-react';
import type { LeaderboardEntry } from '../../types';

interface LeaderboardPanelProps {
  entries: Array<LeaderboardEntry & { rank?: number }>;
  currentUserId?: string;
}

export default function LeaderboardPanel({ entries, currentUserId }: LeaderboardPanelProps) {
  const topEntries = entries.slice(0, 8);

  return (
    <section className="premium-panel h-full overflow-hidden rounded-lg">
      <div className="border-b border-black/[0.07] p-5 dark:border-white/10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-amber-700 dark:text-amber-300">Leaderboard</p>
            <h2 className="text-xl font-semibold text-zinc-950 dark:text-white">Bảng xếp hạng</h2>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300">
            <Trophy size={19} />
          </div>
        </div>
      </div>

      <div className="p-5">
        {topEntries.length === 0 ? (
          <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed border-black/[0.08] bg-white/45 text-center text-sm text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
            Học vài thẻ đầu tiên để mở bảng xếp hạng.
          </div>
        ) : (
          <div className="space-y-2">
            {topEntries.map((entry, index) => {
              const rank = entry.rank ?? index + 1;
              const isCurrentUser = entry.userId === currentUserId;

              return (
                <motion.div
                  key={entry.userId}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.035, duration: 0.28 }}
                  className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                    isCurrentUser
                      ? 'border-primary/30 bg-primary/[0.07]'
                      : 'border-black/[0.07] bg-white/55 dark:border-white/10 dark:bg-white/[0.035]'
                  }`}
                >
                  <RankBadge rank={rank} />
                  <div className="h-10 w-10 overflow-hidden rounded-lg bg-zinc-950 text-white">
                    {entry.avatar ? (
                      <img src={entry.avatar} alt={entry.username} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-sm font-semibold">
                        {entry.username.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-950 dark:text-white">
                      {entry.username}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Level {entry.level}</span>
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                      <span>{entry.totalCardsReviewed.toLocaleString()} thẻ</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm font-semibold text-zinc-950 dark:text-white">
                      {entry.totalExp.toLocaleString()}
                    </p>
                    <p className="flex items-center justify-end gap-1 text-[10px] font-medium text-muted-foreground">
                      <TrendingUp size={11} />
                      EXP
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white shadow-sm">
        <Crown size={15} />
      </div>
    );
  }

  if (rank <= 3) {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
        <Medal size={15} />
      </div>
    );
  }

  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-950/[0.06] font-mono text-xs font-semibold text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
      {rank}
    </div>
  );
}
