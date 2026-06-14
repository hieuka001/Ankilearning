import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { 
  Mic, 
  MicOff, 
  Zap, 
  RotateCcw, 
  Save, 
  Loader2, 
  BrainCircuit, 
  Sparkles,
  Plus,
  Stethoscope,
  Clock,
  FileAudio,
  FileVideo,
  Upload,
  X as XIcon,
  Play
} from 'lucide-react';
import { toast } from 'sonner';
import { generateClinicalFlashcardsFromVoice, generateClinicalFlashcardsFromMedia } from '../services/aiService';
import { db } from '../firebase';
import { collection, addDoc, writeBatch, doc, query, where, getDocs, updateDoc, increment } from 'firebase/firestore';
import { User } from 'firebase/auth';
import { UserProfile, Deck } from '../types';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { createInitialCardSchedule } from '../lib/spacedRepetition';

interface VoiceToCardProps {
  user: User | null;
  profile: UserProfile | null;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export default function VoiceToCard({ user, profile }: VoiceToCardProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedCards, setGeneratedCards] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [existingDecks, setExistingDecks] = useState<Deck[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<string>('new');
  const [deckName, setDeckName] = useState('Case lâm sàng mới');
  
  // File upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const recognitionRef = useRef<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // Check browser support for SpeechRecognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("Speech Recognition not supported in this browser.");
    } else {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = 'vi-VN';

      recognitionRef.current.onresult = (event: any) => {
        let finalTranscript = '';
        let interim = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const trans = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += trans + ' ';
          } else {
            interim += trans;
          }
        }

        if (finalTranscript) {
          setTranscript(prev => prev + finalTranscript);
        }
        setInterimTranscript(interim);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }

    if (user) {
      const q = query(collection(db, 'decks'), where('ownerId', '==', user.uid));
      getDocs(q).then(snap => {
        setExistingDecks(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck)));
      });
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [user]);

  const toggleListening = () => {
    if (!recognitionRef.current) {
      toast.error("Trình duyệt không hỗ trợ ghi âm trực tiếp.");
      return;
    }
    if (isListening) {
      recognitionRef.current.stop();
    } else {
      setSelectedFile(null);
      setFileBase64(null);
      setIsListening(true);
      recognitionRef.current.start();
      toast.info("Đang ghi âm lâm sàng...");
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 20 * 1024 * 1024) { // 20MB limit for better experience
        toast.error("Vui lòng chọn tệp nhỏ hơn 20MB.");
        return;
      }
      
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = (reader.result as string).split(',')[1];
        setFileBase64(base64String);
        setSelectedFile(file);
        setTranscript(''); // Clear transcript if file is selected
        setInterimTranscript('');
        toast.success(`Đã chọn tệp: ${file.name}`);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleClear = () => {
    setTranscript('');
    setInterimTranscript('');
    setGeneratedCards([]);
    setSelectedFile(null);
    setFileBase64(null);
  };

  const handleGenerate = async () => {
    const fullTranscript = (transcript + interimTranscript).trim();
    
    if (!fullTranscript && !fileBase64) {
      toast.error("Vui lòng ghi âm, nhập nội dung hoặc tải lên tệp media.");
      return;
    }

    setIsGenerating(true);
    try {
      let cards = [];
      const keys = { geminiApiKey: profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey };
      
      if (fileBase64 && selectedFile) {
        cards = await generateClinicalFlashcardsFromMedia(fileBase64, selectedFile.type, keys as any);
      } else {
        cards = await generateClinicalFlashcardsFromVoice(fullTranscript, keys as any);
      }
      
      setGeneratedCards(cards);
      toast.success(`AI đã phân tích và tạo ${cards.length} thẻ y khoa!`);
    } catch (error: any) {
      toast.error(error.message || "Lỗi khi xử lý bằng AI.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!user || generatedCards.length === 0) return;
    
    if (selectedDeckId === 'new' && !deckName.trim()) {
      toast.error("Vui lòng nhập tên bộ thẻ.");
      return;
    }

    setIsSaving(true);
    try {
      let deckId = selectedDeckId;

      if (selectedDeckId === 'new') {
        const deckRef = await addDoc(collection(db, 'decks'), {
          ownerId: user.uid,
          name: deckName,
          description: `Ghi chú âm thanh từ môi trường lâm sàng thực tế.`,
          category: 'Cận lâm sàng',
          cardCount: generatedCards.length,
          createdAt: new Date().toISOString(),
          isPublic: false,
          color: '#ef4444',
          authorName: profile?.displayName || 'Unknown'
        });
        deckId = deckRef.id;
      } else {
        await updateDoc(doc(db, 'decks', selectedDeckId), {
          cardCount: increment(generatedCards.length)
        });
      }

      const batch = writeBatch(db);
      generatedCards.forEach(card => {
        const cardRef = doc(collection(db, `decks/${deckId}/cards`));
        batch.set(cardRef, {
          deckId: deckId,
          ownerId: user.uid,
          type: 'basic',
          front: card.front,
          back: card.back,
          tags: ['voice-capture', 'clinical-pearl'],
          ...createInitialCardSchedule(),
          createdAt: new Date().toISOString(),
        });
      });

      await batch.commit();
      toast.success("Đã lưu thẻ y khoa thành công!");
      navigate('/decks');
    } catch {
      toast.error("Lỗi khi lưu dữ liệu.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 md:space-y-12 animate-in fade-in slide-in-from-bottom-8 duration-700 pb-20">
      <header className="text-center space-y-4 md:space-y-6">
        <div className="inline-flex p-4 md:p-6 bg-red-500/10 text-red-500 rounded-[2rem] shadow-2xl shadow-red-500/10 animate-pulse">
          <Mic className="w-8 h-8 md:w-12 md:h-12" />
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tighter">Voice-to-Card</h1>
          <p className="text-slate-500 dark:text-slate-400 text-lg md:text-xl font-medium max-w-2xl mx-auto leading-relaxed">
            Ghi lời bình lâm sàng ngay tại giường bệnh. <span className="text-red-500 font-bold">AI Assistant</span> sẽ tự động trích xuất thành flashcards y khoa súc tích.
          </p>
          <div className="mx-auto grid max-w-3xl grid-cols-2 gap-2 pt-4 text-left md:grid-cols-5">
            {['Audio', 'Transcript', 'AI Summary', 'Flashcards', 'Quiz'].map((step, index) => (
              <div key={step} className="workflow-step p-3">
                <p className="font-mono text-[10px] font-black text-primary">0{index + 1}</p>
                <p className="mt-1 text-xs font-bold text-slate-700 dark:text-slate-200">{step}</p>
              </div>
            ))}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 md:gap-12">
        {/* Recording Section */}
        <div className="space-y-6">
          <Card className="border-none shadow-2xl bg-white dark:bg-[#0C0D0E] rounded-[2.5rem] overflow-hidden">
            <CardHeader className="p-8 md:p-10 border-b border-slate-100 dark:border-white/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-red-500/10 text-red-500 rounded-xl">
                    <Stethoscope size={20} />
                  </div>
                  <CardTitle className="text-xl font-black tracking-tight">Audio Capture</CardTitle>
                </div>
                {isListening && (
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-ping" />
                    <span className="text-[10px] font-black text-red-500 uppercase tracking-widest">Live Recording</span>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-8 md:p-10 space-y-8">
              <div className="relative min-h-[300px] md:min-h-[400px] bg-slate-50 dark:bg-black/40 rounded-[2rem] p-6 md:p-10 overflow-hidden border border-slate-100 dark:border-white/5 flex flex-col">
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  accept="audio/*,video/*"
                  className="hidden"
                />

                {!transcript && !interimTranscript && !selectedFile && !isListening ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-8">
                    <div className="grid grid-cols-2 gap-4 w-full max-w-sm">
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={toggleListening}
                        className="flex flex-col items-center gap-3 p-6 bg-white dark:bg-white/5 rounded-3xl shadow-xl hover:shadow-primary/10 transition-all border border-transparent hover:border-primary/20"
                      >
                        <div className="w-12 h-12 bg-primary/10 text-primary rounded-full flex items-center justify-center">
                          <Mic size={24} />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Live Voice</span>
                      </motion.button>

                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => fileInputRef.current?.click()}
                        className="flex flex-col items-center gap-3 p-6 bg-white dark:bg-white/5 rounded-3xl shadow-xl hover:shadow-red-500/10 transition-all border border-transparent hover:border-red-500/20"
                      >
                        <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center">
                          <Upload size={24} />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Upload Media</span>
                      </motion.button>
                    </div>

                    <div className="space-y-2">
                      <p className="text-slate-400 font-bold text-sm">Ghi âm trực tiếp hoặc tải tệp lên</p>
                      <p className="text-slate-300 dark:text-slate-700 text-xs italic">Hỗ trợ Audio/Video phân tích lâm sàng</p>
                    </div>
                  </div>
                ) : selectedFile ? (
                  <div className="flex-1 flex flex-col items-center justify-center space-y-6">
                    <div className="relative p-8 bg-white dark:bg-white/5 rounded-[2.5rem] shadow-2xl border border-white/5 flex flex-col items-center gap-4">
                      {selectedFile.type.startsWith('video') ? (
                        <FileVideo className="w-16 h-16 text-red-500" />
                      ) : (
                        <FileAudio className="w-16 h-16 text-indigo-500" />
                      )}
                      <div className="text-center">
                        <p className="text-lg font-black text-slate-900 dark:text-white truncate max-w-[200px]">{selectedFile.name}</p>
                        <p className="text-[10px] font-bold text-slate-400">{(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • {selectedFile.type}</p>
                      </div>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => setSelectedFile(null)}
                        className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-lg"
                      >
                        <XIcon size={14} />
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 px-6 py-3 bg-red-500/10 text-red-500 rounded-full">
                      <Zap size={16} className="animate-pulse" />
                      <span className="text-xs font-black uppercase tracking-widest text-red-500">Ready to Analyze with Multimodal AI</span>
                    </div>
                  </div>
                ) : (
                  <div className="prose dark:prose-invert max-w-none flex-1">
                    <p className="text-slate-700 dark:text-slate-200 text-lg md:text-xl font-medium leading-relaxed">
                      {transcript}
                      <span className="text-primary/50 italic">{interimTranscript}</span>
                    </p>
                  </div>
                )}
                
                {isListening && (
                  <div className="absolute bottom-6 right-6 flex items-end gap-1">
                    {[0.2, 0.5, 0.3, 0.8, 0.4].map((h, i) => (
                      <motion.div 
                        key={i}
                        animate={{ height: [`${h * 20}px`, `${h * 40}px`, `${h * 20}px`] }}
                        transition={{ repeat: Infinity, duration: 1, delay: i * 0.1 }}
                        className="w-1 bg-red-500 rounded-full"
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-4">
                <Button 
                  onClick={toggleListening}
                  className={`flex-1 h-16 md:h-20 rounded-2xl md:rounded-[2rem] font-black text-base md:text-xl shadow-2xl transition-all active:scale-95 ${
                    isListening 
                      ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20' 
                      : 'bg-primary hover:bg-primary/90 shadow-primary/20'
                  }`}
                >
                  {isListening ? (
                    <><MicOff className="mr-3 w-6 h-6" /> STOP REC</>
                  ) : (
                    <><Mic className="mr-3 w-6 h-6" /> START REC</>
                  )}
                </Button>
                <Button 
                  variant="outline" 
                  onClick={handleClear}
                  className="w-16 md:w-20 h-16 md:h-20 rounded-2xl md:rounded-[2rem] border-2 border-slate-100 dark:border-white/5 bg-slate-50 dark:bg-white/5 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-500 transition-all"
                >
                  <RotateCcw size={24} />
                </Button>
              </div>

              <Button 
                onClick={handleGenerate}
                disabled={!(transcript + interimTranscript).trim() || isGenerating || isListening}
                className="w-full bg-slate-900 dark:bg-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-100 h-16 md:h-20 rounded-2xl md:rounded-[2rem] font-black text-base md:text-xl shadow-2xl transition-all active:scale-95 gap-3"
              >
                {isGenerating ? <Loader2 className="animate-spin w-6 h-6" /> : <Zap className="w-6 h-6" />}
                TẠO FLASHCARDS Y KHOA
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Results Section */}
        <div className="space-y-6">
          <AnimatePresence mode="wait">
            {generatedCards.length > 0 ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="space-y-6"
              >
                <div className="bg-slate-900 dark:bg-black p-8 md:p-10 rounded-[2.5rem] shadow-2xl space-y-8">
                  <div className="flex items-center justify-between border-b border-white/5 pb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 text-primary rounded-xl">
                        <Sparkles size={20} />
                      </div>
                      <div>
                        <h3 className="text-white text-xl font-black tracking-tight">AI Clinical Cards</h3>
                        <p className="text-[10px] font-black text-white/40 uppercase tracking-widest">Medical Extraction</p>
                      </div>
                    </div>
                    <Button 
                      onClick={handleSave}
                      disabled={isSaving}
                      className="bg-primary hover:bg-primary/90 rounded-xl px-6 font-black text-xs uppercase tracking-widest h-11"
                    >
                      {isSaving ? <Loader2 className="animate-spin w-4 h-4 mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                      SAVE CARDS
                    </Button>
                  </div>

                  <div className="space-y-4">
                    <div className="bg-white/5 p-4 rounded-2xl border border-white/5 space-y-4">
                      <div className="space-y-2">
                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Select Destination</label>
                        <select 
                          value={selectedDeckId}
                          onChange={(e) => setSelectedDeckId(e.target.value)}
                          className="w-full bg-slate-800 border-none rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:ring-2 focus:ring-primary/50"
                        >
                          <option value="new">+ Create New Deck</option>
                          {existingDecks.map(deck => (
                            <option key={deck.id} value={deck.id}>{deck.name}</option>
                          ))}
                        </select>
                      </div>

                      {selectedDeckId === 'new' && (
                        <div className="space-y-2">
                          <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Deck Name</label>
                          <input 
                            value={deckName}
                            onChange={(e) => setDeckName(e.target.value)}
                            className="w-full bg-transparent border-none p-0 focus:ring-0 font-black text-lg text-white placeholder:text-white/20"
                            placeholder="Clinical Case Name..."
                          />
                        </div>
                      )}
                    </div>

                    <div className="space-y-6 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                      {generatedCards.map((card, idx) => (
                        <div key={idx} className="p-6 bg-white/5 border border-white/5 rounded-2xl space-y-4 group hover:bg-white/[0.07] transition-all">
                          <div className="space-y-2">
                            <span className="text-[8px] font-black text-white/30 uppercase tracking-[0.3em]">Front</span>
                            <div className="text-white font-black text-lg leading-tight tracking-tight">
                              <ReactMarkdown>{card.front}</ReactMarkdown>
                            </div>
                          </div>
                          <div className="pt-4 border-t border-white/5 space-y-2">
                            <span className="text-[8px] font-black text-primary/70 uppercase tracking-[0.3em]">Back</span>
                            <div className="text-sm text-slate-400 font-medium leading-relaxed">
                               <ReactMarkdown>{card.back}</ReactMarkdown>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center p-12 space-y-10 bg-slate-50 dark:bg-white/5 rounded-[2.5rem] border border-dashed border-slate-200 dark:border-white/10 opacity-60">
                <div className="relative">
                  <div className="w-24 h-24 bg-white dark:bg-white/5 rounded-full flex items-center justify-center shadow-xl">
                    <BrainCircuit className="text-slate-300 w-12 h-12" />
                  </div>
                  <div className="absolute -top-2 -right-2 p-2 bg-primary text-white rounded-xl shadow-lg">
                    <Plus size={16} />
                  </div>
                </div>
                <div className="space-y-2">
                  <h4 className="text-xl font-black text-slate-800 dark:text-slate-200 tracking-tight">Results will appear here</h4>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400 max-w-xs mx-auto leading-relaxed">
                    AI will extract key clinical pearls from your voice notes.
                  </p>
                </div>
                
                <div className="grid grid-cols-2 gap-4 w-full max-w-sm">
                  <div className="p-4 bg-white dark:bg-white/5 rounded-2xl space-y-2">
                    <Clock size={16} className="text-primary" />
                    <p className="text-[10px] font-black text-slate-400 uppercase">Save Time</p>
                  </div>
                  <div className="p-4 bg-white dark:bg-white/5 rounded-2xl space-y-2">
                    <Zap size={16} className="text-orange-500" />
                    <p className="text-[10px] font-black text-slate-400 uppercase">Deep Insight</p>
                  </div>
                </div>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
