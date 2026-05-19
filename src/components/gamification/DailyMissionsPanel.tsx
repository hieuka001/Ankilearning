import { motion } from 'motion/react';
import { Award, CheckCircle2, Clock3, ClipboardCheck, Flame, Layers3 } from 'lucide-react';
import type { DailyMissionDocument } from '../../types';
import { formatMissionProgress, MISSION_LABELS, calculateUserLevel } from '../../lib/gamification';
import type { UserProfile } from '../../types';

interface DailyMissionsPanelProps {
  missionDoc: DailyMissionDocument | null;
  profile: UserProfile | null;
  loading?: boolean;
}

const missionIcons = {
  study_cards: Layers3,
  complete_quiz: ClipboardCheck,
  online_time: Clock3,
};

export default function DailyMissionsPanel({ missionDoc, profile, loading }: DailyMissionsPanelProps) {
  const totalExp = profile?.totalExp ?? profile?.xp ?? 0;
  const levelInfo = calculateUserLevel(totalExp);
  const missions = missionDoc?.missions || [];
  const completedCount = missions.filter((mission) => mission.completed).length;

  return (
    <section className="premium-panel overflow-hidden rounded-lg">
      <div className="border-b border-black/[0.07] p-5 dark:border-white/10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-primary">Daily Missions</p>
            <h2 className="text-xl font-semibold text-zinc-950 dark:text-white">Nhiệm vụ hôm nay</h2>
          </div>
          <div className="rounded-lg border border-black/[0.07] bg-white/70 px-3 py-2 text-right dark:border-white/10 dark:bg-white/[0.05]">
            <p className="font-mono text-sm font-semibold text-zinc-950 dark:text-white">{completedCount}/3</p>
            <p className="text-[10px] font-medium text-muted-foreground">đã xong</p>
          </div>
        </div>
      </div>

      <div className="p-5">
        <div className="mb-5 rounded-lg border border-black/[0.07] bg-white/60 p-4 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                <Award size={17} />
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-950 dark:text-white">Level {levelInfo.level}</p>
                <p className="font-mono text-xs text-muted-foreground">{totalExp.toLocaleString()} EXP</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
              <Flame size={13} />
              {profile?.streakDays ?? profile?.streak ?? 0} ngày
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${levelInfo.progressPercent}%` }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              className="h-full rounded-full bg-zinc-950 dark:bg-white"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Mốc tiếp theo: {levelInfo.expForNextLevel.toLocaleString()} EXP
          </p>
        </div>

        <div className="space-y-3">
          {loading && missions.length === 0 ? (
            Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-20 animate-pulse rounded-lg bg-black/[0.04] dark:bg-white/[0.06]" />
            ))
          ) : (
            missions.map((mission, index) => {
              const Icon = missionIcons[mission.type];
              const progress = Math.min(100, (mission.progress / Math.max(mission.target, 1)) * 100);

              return (
                <motion.div
                  key={mission.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04, duration: 0.28 }}
                  className="rounded-lg border border-black/[0.07] bg-white/55 p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.035]"
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                        mission.completed
                          ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                          : 'bg-primary/10 text-primary'
                      }`}>
                        {mission.completed ? <CheckCircle2 size={17} /> : <Icon size={17} />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-zinc-950 dark:text-white">
                          {MISSION_LABELS[mission.type]}
                        </p>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {formatMissionProgress(mission)} · +{mission.rewardExp} EXP
                        </p>
                      </div>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase ${
                      mission.completed
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'bg-zinc-950/[0.06] text-zinc-600 dark:bg-white/10 dark:text-zinc-300'
                    }`}>
                      {mission.completed ? 'Done' : 'Active'}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                      className={`h-full rounded-full ${mission.completed ? 'bg-emerald-500' : 'bg-primary'}`}
                    />
                  </div>
                </motion.div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
