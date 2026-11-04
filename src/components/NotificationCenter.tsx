import { useEffect, useMemo, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { Bell, CheckCircle2, Clock, X } from 'lucide-react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { motion, AnimatePresence } from 'motion/react';

import { Button } from '@/components/ui/button';
import { db } from '../firebase';
import type { InAppNotification, UserProfile } from '../types';

interface NotificationCenterProps {
  user: User | null;
  profile: UserProfile | null;
}

function getDateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    dateKey: `${value('year')}-${value('month')}-${value('day')}`,
    timeKey: `${value('hour')}:${value('minute')}`,
  };
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export default function NotificationCenter({ user, profile }: NotificationCenterProps) {
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const shownThisSession = useRef<Set<string>>(new Set());
  const creatingReminder = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const unreadNotifications = useMemo(
    () => notifications.filter((notification) => !notification.readAt),
    [notifications],
  );
  const latestUnread = unreadNotifications[0] || null;
  const reminder = profile?.settings?.studyReminder;

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      setLoaded(false);
      return;
    }

    const notificationsQuery = query(
      collection(db, 'users', user.uid, 'notifications'),
      orderBy('createdAt', 'desc'),
      limit(30),
    );

    return onSnapshot(
      notificationsQuery,
      (snapshot) => {
        setNotifications(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as InAppNotification)));
        setLoaded(true);
      },
      (error) => {
        console.warn('Không tải được danh sách thông báo.', error);
        setLoaded(true);
      },
    );
  }, [user]);

  useEffect(() => {
    if (!user || !loaded || !reminder?.enabled || creatingReminder.current) return;

    const time = reminder.time || '21:00';
    const timeZone = reminder.timezone || 'Asia/Bangkok';

    const createDailyReminder = async () => {
      const { dateKey, timeKey } = getDateTimeParts(new Date(), timeZone);
      if (timeKey < time) return;

      const notificationId = `study-reminder-${dateKey}`;
      if (notifications.some((notification) => notification.id === notificationId)) return;

      creatingReminder.current = true;
      try {
        await setDoc(doc(db, 'users', user.uid, 'notifications', notificationId), {
          id: notificationId,
          userId: user.uid,
          type: 'study-reminder',
          title: 'Đến giờ ôn tập',
          message: 'Bạn có thể mở bộ thẻ và ôn vài phút để giữ nhịp học hôm nay.',
          createdAt: new Date().toISOString(),
          dateKey,
          readAt: '',
          actionLabel: 'Mở tổng quan',
          actionPath: '/',
        } satisfies InAppNotification);
      } finally {
        creatingReminder.current = false;
      }
    };

    createDailyReminder().catch((error) => console.warn('Không tạo được nhắc học hôm nay.', error));
    const interval = window.setInterval(() => {
      createDailyReminder().catch((error) => console.warn('Không tạo được nhắc học hôm nay.', error));
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [loaded, notifications, reminder?.enabled, reminder?.time, reminder?.timezone, user]);

  useEffect(() => {
    if (!latestUnread || shownThisSession.current.has(latestUnread.id)) return;
    shownThisSession.current.add(latestUnread.id);
    setOpen(true);
  }, [latestUnread]);

  // Close the dropdown when clicking outside of it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open ]);

  const markNotificationRead = async (notification: InAppNotification) => {
    if (!user || notification.readAt) return;
    await updateDoc(doc(db, 'users', user.uid, 'notifications', notification.id), {
      readAt: new Date().toISOString(),
    }).catch((error) => console.warn('Không đánh dấu được thông báo đã xem.', error));
  };

  const markAllRead = async () => {
    await Promise.all(unreadNotifications.map(markNotificationRead));
    setOpen(false);
  };

  const openAction = async (notification: InAppNotification) => {
    await markNotificationRead(notification);
    setOpen(false);
    window.location.assign(notification.actionPath || '/');
  };

  if (!user) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Mở thông báo"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-black/[0.08] bg-white/90 text-zinc-900 shadow-sm backdrop-blur-xl transition hover:bg-white dark:border-white/10 dark:bg-zinc-900/90 dark:text-white"
      >
        <Bell className="h-4 w-4" />
        {unreadNotifications.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-bold text-white">
            {Math.min(unreadNotifications.length, 9)}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.section
            className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(92vw,26rem)] overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-2xl dark:border-white/10 dark:bg-zinc-950"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-zinc-200 p-4 dark:border-white/10">
              <div>
                <p className="text-xs font-semibold uppercase text-zinc-500">Thông báo</p>
                <h2 className="mt-1 text-base font-semibold text-zinc-950 dark:text-white">
                  {unreadNotifications.length > 0 ? 'Bạn có thông báo mới' : 'Trung tâm thông báo'}
                </h2>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Đóng thông báo">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="max-h-[56vh] space-y-2 overflow-y-auto p-3">
              {notifications.length === 0 ? (
                <div className="flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 text-center dark:border-white/10">
                  <Bell className="mb-3 h-7 w-7 text-zinc-400" />
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Chưa có thông báo nào</p>
                  <p className="mt-1 text-xs text-zinc-500">Khi đến giờ ôn tập, thông báo sẽ xuất hiện ở đây.</p>
                </div>
              ) : (
                notifications.map((notification) => (
                  <article
                    key={notification.id}
                    className={`rounded-lg border p-4 transition ${
                      notification.readAt
                        ? 'border-zinc-200 bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03]'
                        : 'border-emerald-600/25 bg-emerald-600/[0.055] dark:border-emerald-500/30 dark:bg-emerald-500/10'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {!notification.readAt && <span className="h-2 w-2 rounded-full bg-emerald-600" />}
                          <h3 className="text-sm font-semibold text-zinc-950 dark:text-white">{notification.title}</h3>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{notification.message}</p>
                        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
                          <Clock className="h-3.5 w-3.5" />
                          {formatDateTime(notification.createdAt)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {notification.actionLabel && (
                        <Button type="button" size="sm" onClick={() => openAction(notification)}>
                          {notification.actionLabel}
                        </Button>
                      )}
                      {!notification.readAt && (
                        <Button type="button" size="sm" variant="outline" onClick={() => markNotificationRead(notification)}>
                          <CheckCircle2 className="h-4 w-4" />
                          Đã xem
                        </Button>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>

            {unreadNotifications.length > 0 && (
              <div className="border-t border-zinc-200 bg-zinc-50 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                <Button type="button" className="w-full" onClick={markAllRead}>
                  Xác nhận và tắt
                </Button>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
