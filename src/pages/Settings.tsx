import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { updateProfile, type User } from 'firebase/auth';
import { doc, updateDoc } from 'firebase/firestore';
import { motion } from 'motion/react';
import {
  BadgeCheck,
  Bell,
  Camera,
  Clock,
  ExternalLink,
  Flame,
  Key,
  Languages,
  Loader2,
  Mail,
  Moon,
  Music,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trophy,
  Trash2,
  Upload,
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
import { normalizeLanguage, SUPPORTED_LANGUAGES } from '../lib/language';

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

const AVATAR_CANVAS_SIZE = 320;
const MAX_STATIC_AVATAR_DATA_URL_LENGTH = 420_000;
const MAX_GIF_AVATAR_FILE_SIZE = 640 * 1024;
const MAX_AVATAR_DATA_URL_LENGTH = 900_000;
const SUPPORTED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Không thể đọc file ảnh.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Không thể xử lý ảnh này.'));
    image.src = src;
  });
}

async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!SUPPORTED_AVATAR_TYPES.includes(file.type)) {
    throw new Error('Chỉ hỗ trợ PNG, JPG, WEBP hoặc GIF.');
  }

  if (file.type === 'image/gif') {
    if (file.size > MAX_GIF_AVATAR_FILE_SIZE) {
      throw new Error('GIF upload cần dưới 640KB để lưu trực tiếp. Với GIF lớn hơn, hãy dùng link ảnh.');
    }

    const gifDataUrl = await readFileAsDataUrl(file);
    if (gifDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
      throw new Error('GIF quá lớn để lưu trực tiếp. Hãy dùng link ảnh.');
    }
    return gifDataUrl;
  }

  const originalDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(originalDataUrl);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Trình duyệt không hỗ trợ xử lý ảnh.');
  }

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const cropSize = Math.min(sourceWidth, sourceHeight);
  const sourceX = Math.max(0, (sourceWidth - cropSize) / 2);
  const sourceY = Math.max(0, (sourceHeight - cropSize) / 2);

  canvas.width = AVATAR_CANVAS_SIZE;
  canvas.height = AVATAR_CANVAS_SIZE;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    sourceX,
    sourceY,
    cropSize,
    cropSize,
    0,
    0,
    AVATAR_CANVAS_SIZE,
    AVATAR_CANVAS_SIZE
  );

  let output = canvas.toDataURL('image/webp', 0.82);
  if (output.length > MAX_STATIC_AVATAR_DATA_URL_LENGTH) {
    output = canvas.toDataURL('image/webp', 0.68);
  }

  if (output.length > MAX_STATIC_AVATAR_DATA_URL_LENGTH) {
    throw new Error('Ảnh quá lớn để lưu trực tiếp. Hãy chọn ảnh nhẹ hơn hoặc dùng link ảnh.');
  }

  return output;
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
  const [isSavingReminder, setIsSavingReminder] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileName, setProfileName] = useState(profile?.displayName || user?.displayName || '');
  const [avatarUrl, setAvatarUrl] = useState(profile?.photoURL || user?.photoURL || '');
  const avatarFileInputRef = useRef<HTMLInputElement>(null);
  const reminderSettings = profile?.settings?.studyReminder || settings.studyReminder || {
    enabled: false,
    time: '21:00',
    timezone: 'Asia/Bangkok',
  };
  const [reminderDraft, setReminderDraft] = useState({
    enabled: reminderSettings.enabled,
    time: reminderSettings.time || '21:00',
    timezone: reminderSettings.timezone || 'Asia/Bangkok',
  });
  const schedulerConfig = useMemo(() => normalizeSchedulerConfig(profile?.settings?.scheduler || settings.scheduler), [profile?.settings?.scheduler, settings.scheduler]);
  const [schedulerDraft, setSchedulerDraft] = useState({
    learningSteps: serializeSchedulerSteps(schedulerConfig.learningSteps),
    relearningSteps: serializeSchedulerSteps(schedulerConfig.relearningSteps),
    desiredRetention: String(schedulerConfig.desiredRetention),
    initialDifficulty: String(schedulerConfig.initialDifficulty),
    initialAgain: String(schedulerConfig.initialStability.again),
    initialHard: String(schedulerConfig.initialStability.hard),
    initialGood: String(schedulerConfig.initialStability.good),
    initialEasy: String(schedulerConfig.initialStability.easy),
    newCardsPerDay: String(schedulerConfig.newCardsPerDay),
    reviewsPerDay: String(schedulerConfig.reviewsPerDay),
    maximumInterval: String(schedulerConfig.maximumInterval),
    intervalModifier: String(schedulerConfig.intervalModifier),
    burySiblings: schedulerConfig.burySiblings,
  });

  useEffect(() => {
    setGeminiApiKey(profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey || '');
  }, [profile?.settings?.geminiApiKey, profile?.settings?.aiApiKey]);

  useEffect(() => {
    setProfileName(profile?.displayName || user?.displayName || '');
    setAvatarUrl(profile?.photoURL || user?.photoURL || '');
  }, [profile?.displayName, profile?.photoURL, user?.displayName, user?.photoURL]);

  useEffect(() => {
    setReminderDraft({
      enabled: reminderSettings.enabled,
      time: reminderSettings.time || '21:00',
      timezone: reminderSettings.timezone || 'Asia/Bangkok',
    });
  }, [reminderSettings.enabled, reminderSettings.time, reminderSettings.timezone]);

  useEffect(() => {
    setSchedulerDraft({
      learningSteps: serializeSchedulerSteps(schedulerConfig.learningSteps),
      relearningSteps: serializeSchedulerSteps(schedulerConfig.relearningSteps),
      desiredRetention: String(schedulerConfig.desiredRetention),
      initialDifficulty: String(schedulerConfig.initialDifficulty),
      initialAgain: String(schedulerConfig.initialStability.again),
      initialHard: String(schedulerConfig.initialStability.hard),
      initialGood: String(schedulerConfig.initialStability.good),
      initialEasy: String(schedulerConfig.initialStability.easy),
      newCardsPerDay: String(schedulerConfig.newCardsPerDay),
      reviewsPerDay: String(schedulerConfig.reviewsPerDay),
      maximumInterval: String(schedulerConfig.maximumInterval),
      intervalModifier: String(schedulerConfig.intervalModifier),
      burySiblings: schedulerConfig.burySiblings,
    });
  }, [schedulerConfig]);

  const volumePercent = useMemo(() => Math.round((settings.volume ?? 0.5) * 100), [settings.volume]);
  const savedDisplayName = profile?.displayName || user?.displayName || 'Người dùng';
  const savedPhotoURL = profile?.photoURL || user?.photoURL || '';
  const avatarPreview = avatarUrl.trim() || savedPhotoURL;
  const googleAvatar = user?.providerData.find((provider) => provider.photoURL)?.photoURL || user?.photoURL || '';
  const profileInitial = (savedDisplayName.trim()[0] || 'U').toUpperCase();
  const isLocalAvatarDraft = /^data:image\//i.test(avatarUrl.trim());
  const isGifAvatar = /^data:image\/gif/i.test(avatarPreview) || /\.gif(?:[?#].*)?$/i.test(avatarPreview);
  const currentLanguage = normalizeLanguage(profile?.settings?.language || settings.language);

  const handleBackgroundMusicChange = (enabled: boolean) => {
    updateSettings({ backgroundMusic: enabled });
    window.dispatchEvent(new CustomEvent(AMBIENT_CONTROL_EVENT, {
      detail: {
        enabled,
        volume: settings.volume ?? 0.5
      }
    }));
  };

  const handleAvatarFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) return;

    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setAvatarUrl(dataUrl);
      toast.success(file.type === 'image/gif' ? 'Đã chọn GIF động từ máy.' : 'Đã chọn ảnh từ máy.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể dùng file ảnh này.';
      toast.error(message);
    }
  };

  const handleLanguageChange = async (value: string) => {
    const nextLanguage = normalizeLanguage(value);
    updateSettings({ language: nextLanguage });

    if (!user) return;

    try {
      await updateDoc(doc(db, 'users', user.uid), {
        'settings.language': nextLanguage,
      });
      toast.success('Đã cập nhật ngôn ngữ học tập.');
    } catch {
      toast.error('Không thể lưu ngôn ngữ học tập.');
    }
  };

  const handleSaveProfile = async () => {
    if (!user) return;

    const nextDisplayName = profileName.trim();
    const nextPhotoURL = avatarUrl.trim();

    if (!nextDisplayName) {
      toast.error('Tên hiển thị không được để trống.');
      return;
    }

    if (nextDisplayName.length > 80) {
      toast.error('Tên hiển thị nên dưới 80 ký tự.');
      return;
    }

    const isUploadedAvatar = /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(nextPhotoURL);

    if (isUploadedAvatar && nextPhotoURL.length > MAX_AVATAR_DATA_URL_LENGTH) {
      toast.error('Avatar từ máy quá lớn để lưu. Hãy dùng link ảnh.');
      return;
    }

    if (nextPhotoURL && !/^https?:\/\//i.test(nextPhotoURL) && !isUploadedAvatar) {
      toast.error('Avatar cần là link ảnh http/https hoặc file ảnh upload từ máy.');
      return;
    }

    setIsSavingProfile(true);
    try {
      await updateProfile(user, {
        displayName: nextDisplayName,
        photoURL: isUploadedAvatar ? (user.photoURL || null) : (nextPhotoURL || null),
      });

      await updateDoc(doc(db, 'users', user.uid), {
        displayName: nextDisplayName,
        photoURL: nextPhotoURL,
        updatedAt: new Date().toISOString(),
      });

      updateDoc(doc(db, 'leaderboards', 'global', 'users', user.uid), {
        username: nextDisplayName,
        avatar: nextPhotoURL,
      }).catch(() => undefined);

      toast.success('Đã cập nhật tên và avatar.');
    } catch (error) {
      console.error(error);
      toast.error('Không thể cập nhật hồ sơ.');
    } finally {
      setIsSavingProfile(false);
    }
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
        desiredRetention: Number(schedulerDraft.desiredRetention),
        initialDifficulty: Number(schedulerDraft.initialDifficulty),
        initialStability: {
          again: Number(schedulerDraft.initialAgain),
          hard: Number(schedulerDraft.initialHard),
          good: Number(schedulerDraft.initialGood),
          easy: Number(schedulerDraft.initialEasy),
        },
        newCardsPerDay: Number(schedulerDraft.newCardsPerDay),
        reviewsPerDay: Number(schedulerDraft.reviewsPerDay),
        maximumInterval: Number(schedulerDraft.maximumInterval),
        intervalModifier: Number(schedulerDraft.intervalModifier),
        burySiblings: schedulerDraft.burySiblings,
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

  const handleSaveReminder = async () => {
    if (!user) return;

    const nextReminder = {
      enabled: reminderDraft.enabled,
      time: '21:00',
      timezone: 'Asia/Bangkok',
    };

    setIsSavingReminder(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        'settings.studyReminder': {
          ...(profile?.settings?.studyReminder || {}),
          ...nextReminder,
        },
      });
      updateSettings({ studyReminder: nextReminder });
      setReminderDraft((draft) => ({ ...draft, enabled: nextReminder.enabled }));
      toast.success(nextReminder.enabled ? 'Đã bật thông báo học lúc 21:00.' : 'Đã tắt thông báo học.');
    } catch {
      toast.error('Không thể lưu cài đặt nhắc học.');
    } finally {
      setIsSavingReminder(false);
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
            {savedPhotoURL ? (
              <img
                src={savedPhotoURL}
                alt=""
                referrerPolicy="no-referrer"
                className="h-16 w-16 rounded-lg border border-zinc-200 bg-zinc-100 object-cover shadow-sm dark:border-white/10 dark:bg-white/10"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-100 text-xl font-semibold text-zinc-500 shadow-sm dark:border-white/10 dark:bg-white/10 dark:text-zinc-300">
                {profileInitial}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-xl font-semibold text-zinc-950 dark:text-white">{savedDisplayName}</p>
              <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">{profile?.email || user?.email}</p>
            </div>
          </div>

          <div className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50/80 p-4 dark:border-white/10 dark:bg-white/[0.04]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="relative shrink-0">
                {avatarPreview ? (
                  <img
                    src={avatarPreview}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-20 w-20 rounded-lg border border-zinc-200 bg-white object-cover shadow-sm dark:border-white/10 dark:bg-white/10"
                  />
                ) : (
                  <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-zinc-200 bg-white text-2xl font-semibold text-zinc-500 shadow-sm dark:border-white/10 dark:bg-white/10 dark:text-zinc-300">
                    {profileInitial}
                  </div>
                )}
                <div className="absolute -bottom-2 -right-2 flex h-8 min-w-8 items-center justify-center rounded-lg border border-white bg-zinc-950 px-2 text-white shadow-sm dark:border-zinc-900">
                  {isGifAvatar ? <span className="text-[10px] font-bold">GIF</span> : <Camera className="h-4 w-4" />}
                </div>
              </div>

              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <label className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Tên hiển thị</label>
                  <Input
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    className="mt-2 h-11"
                    placeholder="Nhập tên muốn hiển thị"
                    maxLength={80}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Avatar</label>
                  <Input
                    value={isLocalAvatarDraft ? 'Ảnh/GIF từ máy đã chọn' : avatarUrl}
                    onChange={(event) => setAvatarUrl(event.target.value)}
                    className="mt-2 h-11 font-mono text-xs"
                    placeholder="Dán link https://... hoặc tải file bên dưới"
                    readOnly={isLocalAvatarDraft}
                  />
                  <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                    Hỗ trợ PNG, JPG, WEBP, GIF từ máy hoặc link ảnh trực tiếp. GIF upload giữ nguyên chuyển động nếu file dưới 640KB.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={avatarFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={handleAvatarFileChange}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => avatarFileInputRef.current?.click()}
                    disabled={isSavingProfile}
                    className="h-9 px-3"
                  >
                    <Upload className="h-4 w-4" />
                    Tải ảnh/GIF
                  </Button>
                  <Button type="button" onClick={handleSaveProfile} disabled={isSavingProfile} className="h-9 px-4">
                    {isSavingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Lưu hồ sơ
                  </Button>
                  {googleAvatar ? (
                    <Button type="button" variant="outline" onClick={() => setAvatarUrl(googleAvatar)} disabled={isSavingProfile} className="h-9 px-3">
                      <RefreshCw className="h-4 w-4" />
                      Ảnh Google
                    </Button>
                  ) : null}
                  <Button type="button" variant="ghost" onClick={() => setAvatarUrl('')} disabled={isSavingProfile} className="h-9 px-3">
                    <Trash2 className="h-4 w-4" />
                    Xóa ảnh
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 divide-y divide-zinc-200/70 border-y border-zinc-200/70 dark:divide-white/10 dark:border-white/10">
            <SettingRow
              icon={<UserIcon className="h-4 w-4" />}
              title="Tên hiển thị"
              description={savedDisplayName}
              action={<span className="text-sm font-medium text-primary">Có thể chỉnh sửa</span>}
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
              icon={<Languages className="h-4 w-4" />}
              title="Ngôn ngữ học tập"
              description="Dùng cho ghi âm, phát âm văn bản và trải nghiệm học. Hỗ trợ thêm tiếng Trung."
              action={
                <select
                  value={currentLanguage}
                  onChange={(event) => handleLanguageChange(event.target.value)}
                  className="h-10 min-w-40 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-white/10 dark:bg-white/5 dark:text-white"
                >
                  {SUPPORTED_LANGUAGES.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </select>
              }
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
            <p className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Nhắc học</p>
            <h2 className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-white">Thông báo ôn tập trên web</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              App sẽ tạo thông báo trong hộp thông báo mỗi ngày vào khoảng 21:00 nếu bạn bật nhắc học. Khi đăng nhập lại, thông báo chưa xem sẽ tự hiện lên để xác nhận.
            </p>
          </div>
          <Button type="button" onClick={handleSaveReminder} disabled={isSavingReminder} className="h-10 px-5">
            {isSavingReminder ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Lưu nhắc học
          </Button>
        </div>

        <div className="mt-5 divide-y divide-zinc-200/70 dark:divide-white/10">
          <SettingRow
            icon={<Bell className="h-4 w-4" />}
            title="Bật thông báo hằng ngày"
            description="Thông báo nằm trong app, có thể đóng sau khi xác nhận và mở lại bằng nút chuông."
            action={
              <Switch
                checked={reminderDraft.enabled}
                onCheckedChange={(value) => setReminderDraft((draft) => ({ ...draft, enabled: value }))}
              />
            }
          />
          <SettingRow
            icon={<Clock className="h-4 w-4" />}
            title="Giờ nhắc"
            description="Lịch nhắc cố định theo giờ Việt Nam để phù hợp thói quen ôn bài buổi tối."
            action={
              <div className="flex items-center gap-2">
                <Input value="21:00" disabled className="h-10 w-28 text-center font-mono" />
                <span className="text-sm font-medium text-zinc-500">GMT+7</span>
              </div>
            }
          />
        </div>
      </section>

      <section className="premium-panel p-6 dark:bg-zinc-950/70">
        <div className="flex flex-col gap-5 border-b border-zinc-200/70 pb-5 dark:border-white/10 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">Scheduler</p>
            <h2 className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-white">Thời gian học thẻ</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              FSRS dùng Stability, Difficulty, Retrievability và retention mục tiêu. Bước học nhập dạng <span className="font-mono">1m, 10m, 1d</span>.
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
          {([
            ['desiredRetention', 'Desired retention', '0.01'],
            ['initialDifficulty', 'Initial difficulty', '0.1'],
            ['initialAgain', 'Initial S Again', '0.1'],
            ['initialHard', 'Initial S Hard', '0.1'],
            ['initialGood', 'Initial S Good', '0.1'],
            ['initialEasy', 'Initial S Easy', '0.1'],
            ['newCardsPerDay', 'New / day', '1'],
            ['reviewsPerDay', 'Reviews / day', '1'],
            ['maximumInterval', 'Max interval', '1'],
            ['intervalModifier', 'Interval modifier', '0.05'],
          ] as const).map(([key, label, step]) => (
            <div key={key}>
              <label className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">{label}</label>
              <Input
                type="number"
                step={step}
                min="0"
                value={schedulerDraft[key]}
                onChange={(event) => setSchedulerDraft((draft) => ({ ...draft, [key]: event.target.value }))}
                className="mt-2 h-11 font-mono"
              />
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-white/10 dark:bg-white/5">
          <div>
            <p className="text-sm font-semibold text-zinc-950 dark:text-white">Bury siblings</p>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Ẩn các thẻ cùng note trong cùng một phiên học để giảm gợi nhớ giả.</p>
          </div>
          <Switch
            checked={schedulerDraft.burySiblings}
            onCheckedChange={(value) => setSchedulerDraft((draft) => ({ ...draft, burySiblings: value }))}
          />
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
