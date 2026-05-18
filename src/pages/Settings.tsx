import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { User } from 'firebase/auth';
import { doc, updateDoc } from 'firebase/firestore';
import { motion } from 'motion/react';
import {
  BadgeCheck,
  ExternalLink,
  Flame,
  Key,
  Loader2,
  Mail,
  Moon,
  Music,
  Play,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trophy,
  User as UserIcon,
  Volume2
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { db } from '../firebase';
import { useSettings } from '../contexts/SettingsContext';
import { AMBIENT_CONTROL_EVENT } from '../components/BackgroundMusic';
import { playSound } from '../lib/sounds';
import { UserProfile } from '../types';
import { toast } from 'sonner';
import {
  DEFAULT_SCHEDULER_CONFIG,
  normalizeSchedulerConfig,
  parseSchedulerSteps,
  serializeSchedulerSteps,
} from '../lib/spacedRepetition';

interface SettingsProps {
  user: User | null;
  profile: UserProfile | null;
}

interface SettingRowProps {
  icon: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
}

function SettingRow({ icon, title, description, action }: SettingRowProps) {
  return (
    <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-900 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-white">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-950 dark:text-white">{title}</p>
          <p className="mt-1 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">{description}</p>
        </div>
      </div>
      <div className="shrink-0 sm:pl-6">{action}</div>
    </div>
  );
}

export default function Settings({ user, profile }: SettingsProps) {
  const { settings, updateSettings, toggleDarkMode } = useSettings();
  const [geminiApiKey, setGeminiApiKey] = useState(profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey || '');
  const [isSaving, setIsSaving] = useState(false);
  const schedulerConfig = useMemo(() => normalizeSchedulerConfig(profile?.settings?.scheduler || settings.scheduler), [profile?.settings?.scheduler, settings.scheduler]);
  const [schedulerDraft, setSchedulerDraft] = useState({
    learningSteps: serializeSchedulerSteps(schedulerConfig.learningSteps),
    relearningSteps: serializeSchedulerSteps(schedulerConfig.relearningSteps),
    graduatingInterval: String(schedulerConfig.graduatingInterval),
    easyInterval: String(schedulerConfig.easyInterval),
    hardMultiplier: String(schedulerConfig.hardMultiplier),
    easyBonus: String(schedulerConfig.easyBonus),
    intervalModifier: String(schedulerConfig.intervalModifier),
    minimumEaseFactor: String(schedulerConfig.minimumEaseFactor),
  });

  useEffect(() => {
    setGeminiApiKey(profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey || '');
  }, [profile?.settings?.geminiApiKey, profile?.settings?.aiApiKey]);

  useEffect(() => {
    setSchedulerDraft({
      learningSteps: serializeSchedulerSteps(schedulerConfig.learningSteps),
      relearningSteps: serializeSchedulerSteps(schedulerConfig.relearningSteps),
      graduatingInterval: String(schedulerConfig.graduatingInterval),
      easyInterval: String(schedulerConfig.easyInterval),
      hardMultiplier: String(schedulerConfig.hardMultiplier),
      easyBonus: String(schedulerConfig.easyBonus),
      intervalModifier: String(schedulerConfig.intervalModifier),
      minimumEaseFactor: String(schedulerConfig.minimumEaseFactor),
    });
  }, [schedulerConfig]);

  const volumePercent = useMemo(() => Math.round((settings.volume ?? 0.5) * 100), [settings.volume]);

  const handleBackgroundMusicChange = (enabled: boolean) => {
    updateSettings({ backgroundMusic: enabled });
    window.dispatchEvent(new CustomEvent(AMBIENT_CONTROL_EVENT, {
      detail: {
        enabled,
        volume: settings.volume ?? 0.5
      }
    }));
  };

  const handleSaveKeys = async () => {
    if (!user) return;

    setIsSaving(true);
    try {
      const trimmedKey = geminiApiKey.trim();
      await updateDoc(doc(db, 'users', user.uid), {
        'settings.geminiApiKey': trimmedKey,
        'settings.aiApiKey': trimmedKey
      });
      updateSettings({
        geminiApiKey: trimmedKey,
        aiApiKey: trimmedKey
      });
      toast.success('Đã lưu Gemini API Key.');
    } catch {
      toast.error('Không thể lưu Gemini API Key.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestGemini = async () => {
    const trimmedKey = geminiApiKey.trim();
    if (!trimmedKey) {
      toast.error('Vui lòng nhập Gemini API Key.');
      return;
    }

    setIsSaving(true);
    try {
      const { generateFlashcardsFromText } = await import('../services/aiService');
      await generateFlashcardsFromText('Đau ngực cấp trong y khoa', 1, '', { geminiApiKey: trimmedKey });
      toast.success('Gemini đã kết nối thành công.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể kiểm tra Gemini.';
      toast.error(`Lỗi Gemini: ${message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveScheduler = async () => {
    try {
      const nextScheduler = normalizeSchedulerConfig({
        learningSteps: parseSchedulerSteps(schedulerDraft.learningSteps, DEFAULT_SCHEDULER_CONFIG.learningSteps),
        relearningSteps: parseSchedulerSteps(schedulerDraft.relearningSteps, DEFAULT_SCHEDULER_CONFIG.relearningSteps),
        graduatingInterval: Number(schedulerDraft.graduatingInterval),
        easyInterval: Number(schedulerDraft.easyInterval),
        hardMultiplier: Number(schedulerDraft.hardMultiplier),
        easyBonus: Number(schedulerDraft.easyBonus),
        intervalModifier: Number(schedulerDraft.intervalModifier),
        minimumEaseFactor: Number(schedulerDraft.minimumEaseFactor),
      });

      updateSettings({ scheduler: nextScheduler });

      if (user) {
        await updateDoc(doc(db, 'users', user.uid), {
          'settings.scheduler': nextScheduler,
        });
      }

      toast.success('Đã lưu cấu hình scheduler.');
    } catch {
      toast.error('Không thể lưu cấu hình scheduler.');
    }
  };

  return (
    <motion.div
      className="mx-auto w-full max-w-6xl space-y-8 pt-2"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className="flex flex-col gap-5 border-b border-zinc-200/70 pb-7 dark:border-white/10 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-600 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-zinc-300">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Trải nghiệm cá nhân
          </div>
          <h1 className="text-4xl font-semibold tracking-normal text-zinc-950 dark:text-white md:text-5xl">Cài đặt</h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-zinc-500 dark:text-zinc-400">
            Quản lý tài khoản, Gemini và các tín hiệu âm thanh để phiên học tập tập trung hơn.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-white/10 dark:bg-white/5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-950 dark:text-white">Gemini 2.5 Flash</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">AI đang dùng trong toàn bộ app</p>
          </div>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
        <section className="premium-panel p-6 dark:bg-zinc-950/70">
          <div className="flex items-start justify-between gap-5">
            <div>
              <p className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Hồ sơ</p>
              <h2 className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-white">Tài khoản học tập</h2>
            </div>
            <BadgeCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>

          <div className="mt-7 flex items-center gap-4">
            <img
              src={profile?.photoURL || ''}
              alt=""
              className="h-16 w-16 rounded-lg border border-zinc-200 bg-zinc-100 object-cover shadow-sm dark:border-white/10 dark:bg-white/10"
            />
            <div className="min-w-0">
              <p className="truncate text-xl font-semibold text-zinc-950 dark:text-white">{profile?.displayName || 'Người dùng'}</p>
              <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">{profile?.email || user?.email}</p>
            </div>
          </div>

          <div className="mt-8 divide-y divide-zinc-200/70 border-y border-zinc-200/70 dark:divide-white/10 dark:border-white/10">
            <SettingRow
              icon={<UserIcon className="h-4 w-4" />}
              title="Tên hiển thị"
              description={profile?.displayName || 'Chưa cập nhật'}
              action={<span className="text-sm font-medium text-zinc-500">Google</span>}
            />
            <SettingRow
              icon={<Mail className="h-4 w-4" />}
              title="Email"
              description={profile?.email || user?.email || 'Chưa có email'}
              action={<ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
            />
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-white/10 dark:bg-white/5">
              <Flame className="mb-4 h-4 w-4 text-amber-600 dark:text-amber-400" />
              <p className="font-mono text-2xl font-semibold text-zinc-950 dark:text-white">{profile?.streak || 0}</p>
              <p className="mt-1 text-xs font-medium text-zinc-500">Ngày liên tục</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-white/10 dark:bg-white/5">
              <Trophy className="mb-4 h-4 w-4 text-primary" />
              <p className="font-mono text-2xl font-semibold text-zinc-950 dark:text-white">{profile?.totalCardsLearned || 0}</p>
              <p className="mt-1 text-xs font-medium text-zinc-500">Thẻ đã học</p>
            </div>
          </div>
        </section>

        <section className="premium-panel p-6 dark:bg-zinc-950/70">
          <div className="flex items-start justify-between gap-5">
            <div>
              <p className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Giao diện & âm thanh</p>
              <h2 className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-white">Cảm giác sử dụng</h2>
            </div>
            <Volume2 className="h-5 w-5 text-primary" />
          </div>

          <div className="mt-5 divide-y divide-zinc-200/70 dark:divide-white/10">
            <SettingRow
              icon={settings.darkMode ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              title="Chế độ tối"
              description="Nền graphite, ít chói và hợp khi học lâu vào buổi tối."
              action={<Switch checked={settings.darkMode} onCheckedChange={toggleDarkMode} />}
            />
            <SettingRow
              icon={<Volume2 className="h-4 w-4" />}
              title="Âm thanh thao tác"
              description="Earcon ngắn, nhẹ, chỉ dùng để xác nhận thao tác học."
              action={
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="h-8 w-8"
                    onClick={() => playSound('success')}
                    aria-label="Nghe thử âm thanh"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                  <Switch checked={settings.soundEffects} onCheckedChange={(val) => updateSettings({ soundEffects: val })} />
                </div>
              }
            />
            <SettingRow
              icon={<Music className="h-4 w-4" />}
              title="Nhạc nền tập trung"
              description="Lớp âm trầm rất nhẹ được tạo ngay trong trình duyệt, không phụ thuộc file nhạc ngoài."
              action={<Switch checked={settings.backgroundMusic} onCheckedChange={handleBackgroundMusicChange} />}
            />
            <div className="py-5">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-zinc-950 dark:text-white">Âm lượng tổng</p>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Khuyến nghị giữ thấp để không lấn át nội dung học.</p>
                </div>
                <span className="font-mono text-sm font-semibold text-zinc-950 dark:text-white">{volumePercent}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={volumePercent}
                onChange={(event) => updateSettings({ volume: Number(event.target.value) / 100 })}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-primary dark:bg-white/10"
              />
            </div>
          </div>
        </section>
      </div>

      <section className="premium-panel p-6 dark:bg-zinc-950/70">
        <div className="flex flex-col gap-5 border-b border-zinc-200/70 pb-5 dark:border-white/10 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Scheduler</p>
            <h2 className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-white">Thời gian học thẻ</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              Nhập bước học bằng dạng ngắn như <span className="font-mono">1m, 10m, 1d</span>. Các thay đổi áp dụng cho lượt ôn tiếp theo.
            </p>
          </div>
          <Button type="button" onClick={handleSaveScheduler} className="h-10 px-5">
            <Save className="h-4 w-4" />
            Lưu scheduler
          </Button>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div>
            <label className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Learning steps</label>
            <Input
              value={schedulerDraft.learningSteps}
              onChange={(event) => setSchedulerDraft((draft) => ({ ...draft, learningSteps: event.target.value }))}
              className="mt-2 h-11 font-mono"
              placeholder="1m, 10m, 1d"
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Relearning steps</label>
            <Input
              value={schedulerDraft.relearningSteps}
              onChange={(event) => setSchedulerDraft((draft) => ({ ...draft, relearningSteps: event.target.value }))}
              className="mt-2 h-11 font-mono"
              placeholder="10m, 1d"
            />
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['graduatingInterval', 'Graduating interval'],
            ['easyInterval', 'Easy interval'],
            ['hardMultiplier', 'Hard multiplier'],
            ['easyBonus', 'Easy bonus'],
            ['intervalModifier', 'Interval modifier'],
            ['minimumEaseFactor', 'Minimum ease'],
          ].map(([key, label]) => (
            <div key={key}>
              <label className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">{label}</label>
              <Input
                type="number"
                step="0.05"
                min="0"
                value={schedulerDraft[key as keyof typeof schedulerDraft]}
                onChange={(event) => setSchedulerDraft((draft) => ({ ...draft, [key]: event.target.value }))}
                className="mt-2 h-11 font-mono"
              />
            </div>
          ))}
        </div>
      </section>

      <section className="premium-panel overflow-hidden dark:bg-zinc-950/70">
        <div className="grid lg:grid-cols-[0.82fr_1.18fr]">
          <div className="border-b border-zinc-200/70 p-6 dark:border-white/10 lg:border-b-0 lg:border-r">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950">
              <Key className="h-5 w-5" />
            </div>
            <p className="mt-6 text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">AI engine</p>
            <h2 className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-white">Gemini API</h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              App dùng cùng một key Gemini cho tạo thẻ, trợ lý học tập và luyện đề. Key được lưu theo tài khoản Firebase để đồng bộ giữa các thiết bị.
            </p>
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary/80"
            >
              Mở Google AI Studio
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>

          <div className="p-6">
            <label htmlFor="gemini-key" className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
              Gemini API Key
            </label>
            <div className="mt-3 flex flex-col gap-3 md:flex-row">
              <Input
                id="gemini-key"
                type="password"
                value={geminiApiKey}
                onChange={(event) => setGeminiApiKey(event.target.value)}
                placeholder="AIza..."
                className="h-11 flex-1 font-mono"
              />
              <Button type="button" variant="outline" onClick={handleTestGemini} disabled={isSaving} className="h-11 px-4">
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Thử key
              </Button>
              <Button type="button" onClick={handleSaveKeys} disabled={isSaving} className="h-11 px-5">
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Lưu key
              </Button>
            </div>
            <p className="mt-4 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              Khi deploy công khai, nên giới hạn key theo HTTP referrer trong Google Cloud để kiểm soát mức sử dụng.
            </p>
          </div>
        </div>
      </section>
    </motion.div>
  );
}
