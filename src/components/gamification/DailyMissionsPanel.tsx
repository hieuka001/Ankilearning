import { useState } from 'react';
import { motion } from 'motion/react';
import { Award, CheckCircle2, Clock3, ClipboardCheck, Flame, Layers3, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { DailyMissionDocument, UserProfile } from '../../types';
import {
  DEFAULT_TIMEZONE,
  MISSION_LABELS,
  calculateUserLevel,
  createDefaultDailyMissions,
  formatMissionProgress,
} from '../../lib/gamification';
import { claimMissionReward } from '../../services/gamificationService';

interface DailyMissionsPanelProps {
  missionDoc: DailyMissionDocument | null;
  profile: UserProfile | null;
  loading?: boolean;
  userId?: string;
  timezone?: string;
}

const missionIcons = {
  study_cards: Layers3,
  complete_quiz: ClipboardCheck,
  online_time: Clock3,
};

export default function DailyMissionsPanel({
  missionDoc,
  profile,
  loading,
  userId,
  timezone = DEFAULT_TIMEZONE,
}: DailyMissionsPanelProps) {
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const totalExp = profile?.totalExp ?? profile?.xp ?? 0;
  const levelInfo = calculateUserLevel(totalExp);
  const missions = missionDoc?.missions?.length
    ? missionDoc.missions
    : createDefaultDailyMissions(missionDoc?.dateKey, timezone);
  const completedCount = missions.filter((mission) => mission.completed).length;
  const claimedCount = missions.filter((mission) => mission.claimed).length;

  const handleClaim = async (missionId: string) => {
    if (!userId) return;
    setClaimingId(missionId);
    try {
      const result = await claimMissionReward(userId, missionId, timezone);
      if (result.awardedExp > 0) {
        toast.success(`Đã nhận +${result.awardedExp} EXP.`);
      } else {
        toast.info('Nhiệm vụ này chưa sẵn sàng để nhận.');
      }
    } catch (error) {
      console.warn('Mission claim failed.', error);
      toast.error('Chưa nhận được EXP nhiệm vụ. Hãy thử lại.');
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <section className="premium-panel overflow-hidden rounded-lg">
      <div className="border-b border-black/[0.07] p-5 dark:border-white/10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-primary">Daily Missions</p>
            <h2 className="text-xl font-semibold text-zinc-950 dark:text-white">Nhiệm vụ hôm nay</h2>
          </div>
          <div className="mode-chip px-3 py-2 text-right">
            <p className="font-mono text-sm font-semibold text-zinc-950 dark:text-white">{completedCount}/3</p>
            <p className="text-[10px] font-medium text-muted-foreground">{claimedCount} đã nhận</p>
          </div>
        </div>
      </div>

      <div className="p-5">
        <div className="workflow-step mb-5 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="brand-gradient flex h-9 w-9 items-center justify-center rounded-lg text-white shadow-lg shadow-indigo-500/20">
                <Award size={17} />
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-950 dark:text-white">Level {levelInfo.level}</p>
                <p className="font-mono text-xs text-muted-foreground">{totalExp.toLocaleString()} EXP</p>
              </div>
            </div>
            <div className="achievement-badge">
              <Flame size={13} />
              {profile?.streakDays ?? profile?.streak ?? 0} ngày
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${levelInfo.progressPercent}%` }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              className="xp-gradient h-full rounded-full"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Mốc tiếp theo: {levelInfo.expForNextLevel.toLocaleString()} EXP
          </p>
        </div>

        <div className="space-y-3">
          {loading && !missionDoc ? (
            Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-20 animate-pulse rounded-lg bg-black/[0.04] dark:bg-white/[0.06]" />
            ))
          ) : (
            missions.map((mission, index) => {
              const Icon = missionIcons[mission.type];
              const progress = Math.min(100, (mission.progress / Math.max(mission.target, 1)) * 100);
              const canClaim = mission.completed && !mission.claimed && !!userId;

              return (
                <motion.div
                  key={mission.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04, duration: 0.28 }}
                  className="workflow-step p-4 transition-all hover:-translate-y-0.5 hover:border-primary/25"
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                        mission.completed
                          ? 'bg-violet-500/12 text-violet-700 dark:text-violet-300'
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
                    <Button
                      size="sm"
                      onClick={() => handleClaim(mission.id)}
                      disabled={!canClaim || claimingId === mission.id}
                      className={`h-8 min-w-20 rounded-lg px-3 text-xs font-semibold transition-all ${
                        canClaim
                          ? 'brand-gradient text-white shadow-lg shadow-indigo-500/20'
                          : 'border border-black/[0.07] bg-zinc-950/[0.04] text-zinc-500 opacity-55 hover:bg-zinc-950/[0.04] dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-400'
                      }`}
                    >
                      {claimingId === mission.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : mission.claimed ? (
                        'Đã nhận'
                      ) : (
                        'Nhận'
                      )}
                    </Button>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                      className={`h-full rounded-full ${mission.completed ? 'xp-gradient' : 'brand-gradient'}`}
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
