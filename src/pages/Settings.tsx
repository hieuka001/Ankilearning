import { useEffect, useState } from 'react';
import { UserProfile } from '../types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ShieldCheck, User as UserIcon, Mail, Calendar, Trophy, Flame, Moon, Sun, Volume2, Music, Settings as SettingsIcon, Key, ExternalLink, Save, Loader2 } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { toast } from 'sonner';

import { User } from 'firebase/auth';

interface SettingsProps {
  user: User | null;
  profile: UserProfile | null;
}

export default function Settings({ user, profile }: SettingsProps) {
  const { settings, updateSettings, toggleDarkMode } = useSettings();
  const [geminiApiKey, setGeminiApiKey] = useState(profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey || '');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setGeminiApiKey(profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey || '');
  }, [profile?.settings?.geminiApiKey, profile?.settings?.aiApiKey]);

  const handleSaveKeys = async () => {
    if (!user) return;
    
    setIsSaving(true);
    try {
      const trimmedKey = geminiApiKey.trim();
      await updateDoc(doc(db, 'users', user.uid), {
        'settings.geminiApiKey': trimmedKey,
        'settings.aiApiKey': trimmedKey
      });
      // Also update local settings context if you want it to be immediate everywhere
      updateSettings({
        geminiApiKey: trimmedKey,
        aiApiKey: trimmedKey
      });
      toast.success('Đã lưu Gemini API Key.');
    } catch {
      toast.error('Lỗi khi lưu Gemini API Key.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-8 duration-700 pt-6">
      <header className="space-y-4">
        <h1 className="text-5xl font-black text-slate-900 dark:text-white tracking-tighter">Tài khoản & Cài đặt</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xl font-medium">Thông tin cá nhân và tùy chỉnh trải nghiệm học tập của bạn.</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        {/* Profile Info Card */}
        <Card className="border border-slate-200 dark:border-white/5 shadow-2xl rounded-[3rem] overflow-hidden bg-white dark:bg-[#0C0D0E]">
          <CardHeader className="bg-slate-900 dark:bg-black text-white p-10 border-b border-white/5">
            <CardTitle className="flex items-center gap-3 text-2xl font-black tracking-tight">
              <ShieldCheck className="text-primary w-7 h-7" />
              Thông tin cá nhân
            </CardTitle>
            <CardDescription className="text-slate-400 font-medium">
              Chi tiết tài khoản Google đã kết nối với hệ thống.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-10 space-y-10">
            <div className="flex items-center gap-6 p-6 bg-slate-50 dark:bg-white/5 rounded-[2rem] border border-slate-100 dark:border-white/5 transition-transform hover:scale-[1.02]">
              <img 
                src={profile?.photoURL || ''} 
                alt="" 
                className="h-20 w-20 rounded-full border-4 border-white dark:border-white/10 shadow-2xl"
              />
              <div>
                <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">{profile?.displayName}</h3>
                <p className="text-base text-slate-500 dark:text-slate-400 font-medium">{profile?.email}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6">
              <div className="flex items-center gap-4 p-4">
                <div className="p-4 bg-primary/10 text-primary rounded-2xl">
                  <UserIcon className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Tên hiển thị</p>
                  <p className="text-xl font-black text-slate-900 dark:text-white tracking-tight">{profile?.displayName || 'Chưa cập nhật'}</p>
                </div>
              </div>
              <div className="flex items-center gap-4 p-4">
                <div className="p-4 bg-primary/10 text-primary rounded-2xl">
                  <Mail className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Email</p>
                  <p className="text-xl font-black text-slate-900 dark:text-white tracking-tight">{profile?.email}</p>
                </div>
              </div>
            </div>

          </CardContent>
        </Card>

        {/* App Settings Card */}
        <Card className="border border-slate-200 dark:border-white/5 shadow-2xl rounded-[3rem] overflow-hidden bg-white dark:bg-[#0C0D0E]">
          <CardHeader className="bg-primary text-white p-10 border-b border-white/5">
            <CardTitle className="flex items-center gap-3 text-2xl font-black tracking-tight">
              <SettingsIcon className="w-7 h-7" />
              Cài đặt ứng dụng
            </CardTitle>
            <CardDescription className="text-white/80 font-medium">
              Tùy chỉnh giao diện, âm thanh và hiệu ứng.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-10 space-y-10">
            <div className="space-y-6">
              <div className="flex items-center justify-between p-6 bg-slate-50 dark:bg-white/5 rounded-[2rem] border border-slate-100 dark:border-white/5 transition-all hover:bg-slate-100 dark:hover:bg-white/10">
                <div className="flex items-center gap-4">
                  <div className="p-4 bg-primary/10 text-primary rounded-2xl">
                    {settings.darkMode ? <Moon className="w-6 h-6" /> : <Sun className="w-6 h-6" />}
                  </div>
                  <div>
                    <p className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Chế độ tối</p>
                    <p className="text-xs text-slate-500 font-medium">Giao diện tối giúp dịu mắt hơn.</p>
                  </div>
                </div>
                <Switch checked={settings.darkMode} onCheckedChange={toggleDarkMode} className="data-[state=checked]:bg-primary" />
              </div>

              <div className="flex items-center justify-between p-6 bg-slate-50 dark:bg-white/5 rounded-[2rem] border border-slate-100 dark:border-white/5 transition-all hover:bg-slate-100 dark:hover:bg-white/10">
                <div className="flex items-center gap-4">
                  <div className="p-4 bg-primary/10 text-primary rounded-2xl">
                    <Volume2 className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Âm thanh hiệu ứng</p>
                    <p className="text-xs text-slate-500 font-medium">Âm thanh khi lật thẻ và trả lời.</p>
                  </div>
                </div>
                <Switch 
                  checked={settings.soundEffects} 
                  onCheckedChange={(val) => updateSettings({ soundEffects: val })} 
                  className="data-[state=checked]:bg-primary"
                />
              </div>

              <div className="flex items-center justify-between p-6 bg-slate-50 dark:bg-white/5 rounded-[2rem] border border-slate-100 dark:border-white/5 transition-all hover:bg-slate-100 dark:hover:bg-white/10">
                <div className="flex items-center gap-4">
                  <div className="p-4 bg-primary/10 text-primary rounded-2xl">
                    <Music className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Nhạc nền</p>
                    <p className="text-xs text-slate-500 font-medium">Nhạc nhẹ nhàng giúp tập trung hơn.</p>
                  </div>
                </div>
                <Switch 
                  checked={settings.backgroundMusic} 
                  onCheckedChange={(val) => updateSettings({ backgroundMusic: val })} 
                  className="data-[state=checked]:bg-primary"
                />
              </div>
            </div>

            {/* Stats Card */}
            <div className="grid grid-cols-2 gap-6 pt-4">
              <div className="p-8 bg-slate-50 dark:bg-white/5 rounded-[2rem] border border-slate-100 dark:border-white/5 text-center transition-transform hover:scale-[1.02]">
                <div className="flex justify-center mb-4 text-orange-500">
                  <Flame className="w-8 h-8" />
                </div>
                <p className="text-3xl font-black text-slate-900 dark:text-white font-mono">{profile?.streak || 0}</p>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mt-2">Ngày liên tiếp</p>
              </div>
              <div className="p-8 bg-slate-50 dark:bg-white/5 rounded-[2rem] border border-slate-100 dark:border-white/5 text-center transition-transform hover:scale-[1.02]">
                <div className="flex justify-center mb-4 text-primary">
                  <ShieldCheck className="w-8 h-8" />
                </div>
                <p className="text-3xl font-black text-slate-900 dark:text-white font-mono">{profile?.totalCardsLearned || 0}</p>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mt-2">Thẻ đã học</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* AI Configuration Card */}
        <Card className="border border-slate-200 dark:border-white/5 shadow-2xl rounded-[3rem] overflow-hidden bg-white dark:bg-[#0C0D0E] lg:col-span-2">
          <CardHeader className="bg-indigo-700 text-white p-10 border-b border-white/5">
              <CardTitle className="flex items-center gap-3 text-2xl font-black tracking-tight">
                <Key className="w-7 h-7" />
                Cấu hình AI (Gemini)
              </CardTitle>
              <CardDescription className="text-white/80 font-medium">
                Toàn bộ tính năng AI trong ứng dụng dùng trực tiếp Gemini.
              </CardDescription>
          </CardHeader>
          <CardContent className="p-10 space-y-8">
            <div className="bg-indigo-50 dark:bg-indigo-900/20 p-8 rounded-[2rem] border border-indigo-100 dark:border-indigo-800/50 space-y-4">
              <div className="flex items-start gap-4">
                <div className="p-3 bg-white dark:bg-indigo-900/50 rounded-xl text-indigo-600 shadow-sm">
                  <ExternalLink className="w-5 h-5" />
                </div>
                <div className="space-y-2">
                  <h4 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Gemini API Key</h4>
                  <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                    Tạo hoặc xem key tại <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-indigo-600 font-bold underline">Google AI Studio</a>, sau đó dán vào ô bên dưới. Khi deploy Vercel cũng có thể đặt biến môi trường <b>GEMINI_API_KEY</b> để dùng làm khóa mặc định.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="space-y-4">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">Gemini API Key</label>
                <div className="flex flex-col md:flex-row gap-4">
                  <Input
                    type="password"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    placeholder="AIza..."
                    className="flex-1 h-14 bg-slate-50 dark:bg-white/5 border-slate-200 dark:border-white/10 rounded-2xl px-6 text-lg font-mono focus:ring-primary/20"
                  />
                  <Button
                    onClick={async () => {
                      const trimmedKey = geminiApiKey.trim();
                      if (!trimmedKey) return toast.error('Vui lòng nhập Gemini API Key.');
                      setIsSaving(true);
                      try {
                        const { generateFlashcardsFromText } = await import('../services/aiService');
                        await generateFlashcardsFromText('Đau ngực cấp trong y khoa', 1, '', { geminiApiKey: trimmedKey });
                        toast.success('Gemini kết nối thành công!');
                      } catch (e: any) {
                        toast.error(`Lỗi Gemini: ${e.message}`);
                      } finally {
                        setIsSaving(false);
                      }
                    }}
                    disabled={isSaving}
                    variant="outline"
                    className="h-14 px-6 border-indigo-200 dark:border-indigo-800 text-indigo-600 rounded-2xl font-bold hover:bg-indigo-50"
                  >
                    THỬ KEY
                  </Button>
                </div>
              </div>

              <div className="flex justify-end pt-4">
                <Button
                  onClick={handleSaveKeys}
                  disabled={isSaving}
                  className="h-14 px-10 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-lg shadow-indigo-200 dark:shadow-none gap-2 transition-all active:scale-95"
                >
                  {isSaving ? <Loader2 className="animate-spin w-5 h-5" /> : <Save className="w-5 h-5" />}
                  LƯU GEMINI KEY
                </Button>
              </div>
              <p className="text-xs text-slate-500 italic ml-2">
                * API Key được lưu trong tài khoản Firebase của bạn và dùng để gọi Gemini từ trình duyệt. Nên giới hạn key theo HTTP referrer trong Google Cloud khi dùng bản deploy công khai.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
