import React, { useState, useEffect, useRef } from 'react';
import { Send, User, Bot, Loader2, Mic, MicOff, Volume2, Play, Radio } from 'lucide-react';
import { GoogleGenAI, Modality, ThinkingLevel, LiveServerMessage } from "@google/genai";
import Markdown from 'react-markdown';
import { motion, AnimatePresence } from 'motion/react';
import { getProgress, updateProgress } from '../utils/progress';
import { AudioProcessor, AudioPlayer } from '../utils/audio';

interface Message {
  role: 'user' | 'model';
  text: string;
  isPronunciationFeedback?: boolean;
  isLive?: boolean;
}

export const Chat: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', text: "Bonjour ! Je suis votre partenaire de conversation pour atteindre le niveau C1. De quoi aimeriez-vous discuter aujourd'hui ?\n\n💡 **Nouveau :** Utilisez le mode 'Live' pour une conversation vocale fluide et instantanée !" }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pronunciationTarget, setPronunciationTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<PermissionState | 'unknown'>('unknown');
  const [retryCount, setRetryCount] = useState(0);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const liveSessionRef = useRef<any>(null);
  const audioProcessorRef = useRef<AudioProcessor | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const liveTranscriptionRef = useRef<string>("");

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (navigator.permissions && (navigator.permissions as any).query) {
      navigator.permissions.query({ name: 'microphone' as any })
        .then((status) => {
          setPermissionStatus(status.state);
          status.onchange = () => setPermissionStatus(status.state);
        })
        .catch(() => setPermissionStatus('unknown'));
    }
  }, []);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (e) {}
      }
      if (liveSessionRef.current) {
        liveSessionRef.current.close();
      }
      if (audioProcessorRef.current) {
        audioProcessorRef.current.stop();
      }
      if (audioPlayerRef.current) {
        audioPlayerRef.current.stop();
      }
    };
  }, []);

  const startLiveSession = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      
      audioPlayerRef.current = new AudioPlayer(24000);
      audioProcessorRef.current = new AudioProcessor(16000);

      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "Tu es un partenaire de conversation français natif pour un étudiant de niveau B2/C1. Parle naturellement, utilise un langage soutenu mais accessible. Encourage l'utilisateur à s'exprimer sur des sujets complexes.",
        },
        callbacks: {
          onopen: () => {
            console.log("Live session opened");
            setIsLoading(false);
            setIsListening(true);
            setIsLiveMode(true);
            
            audioProcessorRef.current?.start((base64Data) => {
              sessionPromise.then((session) => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle audio output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              audioPlayerRef.current?.playChunk(base64Audio);
            }

            // Handle interruption
            if (message.serverContent?.interrupted) {
              audioPlayerRef.current?.stop();
              audioPlayerRef.current = new AudioPlayer(24000); // Reset player
            }

            // Handle transcription (if needed for UI)
            // Note: Live API doesn't always send text parts unless configured, 
            // but we can use it if available.
          },
          onclose: () => {
            console.log("Live session closed");
            stopLiveSession();
          },
          onerror: (err) => {
            console.error("Live session error:", err);
            setError("Erreur de session en direct. Veuillez réessayer.");
            stopLiveSession();
          }
        }
      });

      liveSessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Failed to start live session:", err);
      setError("Impossible de démarrer la session en direct.");
      setIsLoading(false);
    }
  };

  const stopLiveSession = () => {
    if (liveSessionRef.current) {
      liveSessionRef.current.close();
      liveSessionRef.current = null;
    }
    if (audioProcessorRef.current) {
      audioProcessorRef.current.stop();
      audioProcessorRef.current = null;
    }
    if (audioPlayerRef.current) {
      audioPlayerRef.current.stop();
      audioPlayerRef.current = null;
    }
    setIsListening(false);
    setIsLiveMode(false);
    setIsLoading(false);
  };

  const initSpeechRecognition = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'fr-FR';

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        handleVoiceInput(transcript);
        setIsListening(false);
        setRetryCount(0); // Reset on success
      };

      recognition.onerror = (event: any) => {
        const errorType = event.error;
        console.error('Speech recognition error:', errorType);
        
        // Don't set isListening to false immediately if we are retrying
        if (errorType === 'network' && retryCount < 3) {
          recognitionRef.current = null;
          const delay = (retryCount + 1) * 1500;
          console.log(`Network error. Retrying in ${delay}ms... (${retryCount + 1}/3)`);
          setRetryCount(prev => prev + 1);
          setTimeout(() => {
            if (navigator.onLine) {
              toggleListening();
            } else {
              setIsListening(false);
              setError("Connexion perdue. La reconnaissance vocale nécessite une connexion internet active.");
              setRetryCount(0);
            }
          }, delay);
          return;
        }

        setIsListening(false);
        recognitionRef.current = null;
        
        if (errorType === 'network') {
          setError("Erreur réseau persistante. La reconnaissance vocale de Google est injoignable. Conseils : 1. Vérifiez votre connexion. 2. Utilisez Google Chrome. 3. Désactivez tout VPN ou pare-feu restrictif.");
          setRetryCount(0);
        } else if (errorType === 'not-allowed') {
          setPermissionStatus('denied');
          setError("Accès au microphone bloqué. Pour corriger cela : 1. Cliquez sur l'icône de cadenas (🔒) à gauche de l'URL. 2. Trouvez 'Microphone' et réinitialisez ou autorisez l'accès. 3. Rafraîchissez la page.");
        } else if (errorType === 'no-speech') {
          // No speech detected, just stop silently
        } else if (errorType === 'aborted') {
          // Manually stopped, no error needed
        } else {
          setError(`Erreur de reconnaissance vocale : ${errorType}`);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      return recognition;
    }
    return null;
  };

  const [isVoiceInitiated, setIsVoiceInitiated] = useState(false);

  const handleVoiceInput = async (transcript: string) => {
    if (pronunciationTarget) {
      // We are in pronunciation practice mode
      setMessages(prev => [...prev, { role: 'user', text: `*(Prononciation)* : ${transcript}` }]);
      await getPronunciationFeedback(transcript, pronunciationTarget);
      setPronunciationTarget(null);
    } else {
      setInput(transcript);
      setIsVoiceInitiated(true);
      // Automatically send after voice input for faster flow
      setTimeout(() => handleSend(transcript), 500);
    }
  };

  const toggleListening = async () => {
    if (isLiveMode) {
      stopLiveSession();
      return;
    }

    // Clear error only when manually starting, not during auto-retry
    if (!isListening && retryCount === 0) setError(null);
    
    if (isListening && retryCount === 0) {
      try {
        recognitionRef.current?.stop();
      } catch (e) {
        recognitionRef.current?.abort();
      }
      setIsListening(false);
      return;
    }

    if (permissionStatus === 'denied') {
      setError("Le microphone est bloqué. Cliquez sur le cadenas (🔒) à côté de l'URL, autorisez le microphone, puis rafraîchissez la page.");
      return;
    }

    // Try to trigger the native prompt if we don't have permission yet
    if (permissionStatus === 'prompt' || permissionStatus === 'unknown') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop()); // Close the stream immediately
        setPermissionStatus('granted');
      } catch (e: any) {
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          setPermissionStatus('denied');
          setError("Accès au microphone refusé. Veuillez l'autoriser dans les paramètres de votre navigateur (icône 🔒).");
          return;
        }
        console.error("Microphone access error:", e);
      }
    }

    if (!window.isSecureContext) {
      setError("La reconnaissance vocale nécessite une connexion sécurisée (HTTPS).");
      return;
    }

    if (!navigator.onLine) {
      setError("Vous êtes hors ligne. La reconnaissance vocale nécessite une connexion internet.");
      return;
    }

    // Always ensure we have a fresh instance if we're starting
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (e) {}
    }
    
    recognitionRef.current = initSpeechRecognition();
    
    if (recognitionRef.current) {
      try {
        setIsListening(true);
        recognitionRef.current.start();
      } catch (e) {
        console.error("Failed to start recognition", e);
        setIsListening(false);
        setError("Impossible de démarrer la reconnaissance vocale. Veuillez rafraîchir la page.");
      }
    } else {
      setError("Votre navigateur ne supporte pas la reconnaissance vocale.");
    }
  };

  const addWavHeader = (pcmData: Uint8Array, sampleRate: number) => {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    
    // RIFF identifier
    view.setUint32(0, 0x52494646, false); // "RIFF"
    // file length
    view.setUint32(4, 36 + pcmData.length, true);
    // RIFF type
    view.setUint32(8, 0x57415645, false); // "WAVE"
    
    // format chunk identifier
    view.setUint32(12, 0x666d7420, false); // "fmt "
    // format chunk length
    view.setUint32(16, 16, true);
    // sample format (raw)
    view.setUint16(20, 1, true);
    // channel count
    view.setUint16(22, 1, true);
    // sample rate
    view.setUint32(24, sampleRate, true);
    // byte rate (sample rate * block align)
    view.setUint32(28, sampleRate * 2, true);
    // block align (channel count * bytes per sample)
    view.setUint16(32, 2, true);
    // bits per sample
    view.setUint16(34, 16, true);
    
    // data chunk identifier
    view.setUint32(36, 0x64617461, false); // "data"
    // data chunk length
    view.setUint32(40, pcmData.length, true);
    
    const wav = new Uint8Array(header.byteLength + pcmData.length);
    wav.set(new Uint8Array(header), 0);
    wav.set(pcmData, 44);
    
    return wav;
  };

  const playTTS = async (text: string) => {
    if (isPlaying) return;
    setIsPlaying(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Prononce cette phrase française avec une voix naturelle et claire : ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        // Gemini TTS returns raw PCM 16-bit 24kHz. Browser needs a WAV header to play it via Audio object.
        const binaryString = atob(base64Audio);
        const pcmData = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          pcmData[i] = binaryString.charCodeAt(i);
        }
        
        const wavData = addWavHeader(pcmData, 24000);
        const audioBlob = new Blob([wavData], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.onended = () => {
          setIsPlaying(false);
          URL.revokeObjectURL(audioUrl);
        };
        await audio.play();
      } else {
        setIsPlaying(false);
      }
    } catch (error) {
      console.error("TTS Error:", error);
      setIsPlaying(false);
      setError("Erreur lors de la génération de l'audio.");
    }
  };

  const startPronunciationPractice = () => {
    const phrases = [
      "L'intelligence artificielle transforme radicalement le marché du travail.",
      "Il est indispensable que nous prenions des mesures drastiques pour l'environnement.",
      "La laïcité est un pilier fondamental de la République française.",
      "Nonobstant les difficultés, la croissance économique semble se stabiliser.",
      "Le subjonctif est souvent utilisé pour exprimer le doute ou le souhait."
    ];
    const target = phrases[Math.floor(Math.random() * phrases.length)];
    setPronunciationTarget(target);
    setMessages(prev => [...prev, { 
      role: 'model', 
      text: `D'accord ! Essayez de prononcer cette phrase :\n\n> **${target}**\n\nCliquez sur le micro et parlez.` 
    }]);
  };

  const getPronunciationFeedback = async (spokenText: string, targetText: string) => {
    setIsLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      const stream = await ai.models.generateContentStream({
        model: "gemini-3-flash-preview",
        contents: `L'utilisateur essaie de pratiquer sa prononciation française.
        Phrase cible : "${targetText}"
        Ce que l'outil de reconnaissance vocale a entendu : "${spokenText}"
        
        Analyse la différence. Si c'est identique, félicite-le. 
        Si c'est différent, explique quelles pourraient être les erreurs de prononciation (ex: sons nasaux, liaisons, voyelles).
        Donne des conseils précis pour améliorer la prononciation de cette phrase spécifique.
        Réponds en français, de manière constructive.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });

      // Add an empty message for the model response
      setMessages(prev => [...prev, { 
        role: 'model', 
        text: "",
        isPronunciationFeedback: true 
      }]);
      
      let fullText = "";
      for await (const chunk of stream) {
        fullText += chunk.text || "";
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].text = fullText;
          return newMessages;
        });
      }
      updateProgress({ pronunciationPractices: getProgress().pronunciationPractices + 1 });
    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { role: 'model', text: "Erreur lors de l'analyse de la prononciation." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async (overrideInput?: string) => {
    const messageText = overrideInput || input;
    if (!messageText.trim() || isLoading) return;

    const userMessage = messageText.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setIsLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      const chat = ai.chats.create({
        model: "gemini-3-flash-preview",
        config: {
          systemInstruction: "Tu es un partenaire de conversation français natif, cultivé et patient. Ton objectif est d'aider l'utilisateur à passer du niveau B1 au niveau B2/C1. Utilise un vocabulaire riche, des structures complexes (subjonctif, conditionnel, connecteurs logiques) et corrige discrètement les erreurs de l'utilisateur si elles sont importantes. Encourage la discussion sur des sujets abstraits et sociétaux.",
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        },
        history: messages
          .filter(m => !m.isPronunciationFeedback)
          .slice(-10) // Limit history to the last 10 messages for faster processing
          .map(m => ({ role: m.role, parts: [{ text: m.text }] }))
      });

      const stream = await chat.sendMessageStream({ message: userMessage });
      
      // Add an empty message for the model response
      setMessages(prev => [...prev, { role: 'model', text: "" }]);
      
      let fullText = "";
      for await (const chunk of stream) {
        fullText += chunk.text || "";
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].text = fullText;
          return newMessages;
        });
      }
      
      updateProgress({ messagesSent: getProgress().messagesSent + 1 });
      
      // Automatically play TTS if it was voice initiated
      if (isVoiceInitiated) {
        playTTS(fullText);
        setIsVoiceInitiated(false);
      }
    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { role: 'model', text: "Une erreur est survenue lors de la connexion à l'IA." }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[600px] bg-white rounded-2xl shadow-sm border border-black/5 overflow-hidden">
      <div className="p-4 border-bottom border-black/5 bg-[#f5f2ed]/50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#5A5A40] flex items-center justify-center text-white">
            <Bot size={20} />
          </div>
          <div>
            <h3 className="font-serif font-semibold">Conversation Avancée</h3>
            <p className="text-xs text-gray-500">Objectif B2/C1</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={isLiveMode ? stopLiveSession : startLiveSession}
            disabled={isLoading && !isLiveMode}
            className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1 px-3 py-1 rounded-full transition-all ${
              isLiveMode 
              ? 'bg-red-100 text-red-600 border border-red-200 animate-pulse' 
              : 'bg-[#5A5A40]/10 text-[#5A5A40] border border-[#5A5A40]/20 hover:bg-[#5A5A40]/20'
            }`}
          >
            <Radio size={14} className={isLiveMode ? 'animate-pulse' : ''} />
            {isLiveMode ? 'Mode Live Actif' : 'Passer en Mode Live'}
          </button>
          <button 
            onClick={startPronunciationPractice}
            className="text-xs font-bold uppercase tracking-wider text-[#5A5A40] hover:underline flex items-center gap-1"
          >
            <Volume2 size={14} /> Pratiquer la prononciation
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50/30">
        <AnimatePresence initial={false}>
          {messages.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[80%] p-3 rounded-2xl ${
                m.role === 'user' 
                ? 'bg-[#5A5A40] text-white rounded-tr-none' 
                : m.isPronunciationFeedback 
                  ? 'bg-amber-50 border border-amber-200 text-[#1a1a1a] rounded-tl-none shadow-sm'
                  : 'bg-white border border-black/5 text-[#1a1a1a] rounded-tl-none shadow-sm'
              }`}>
                <div className="markdown-body text-sm">
                  <Markdown>{m.text}</Markdown>
                </div>
                {m.role === 'model' && (
                  <button 
                    onClick={() => {
                      // If it's a practice prompt, extract the phrase. 
                      // Otherwise, if it's feedback, we might want to play the target phrase again.
                      // For now, let's try to extract the bolded phrase if it exists, 
                      // otherwise play the whole text if it's short, or just the first sentence.
                      let textToPlay = m.text;
                      const match = m.text.match(/> \*\*(.*)\*\*/);
                      if (match) {
                        textToPlay = match[1];
                      } else if (m.isPronunciationFeedback) {
                        // In feedback, maybe play the target phrase if we can find it in history
                        // But for simplicity, let's just play the text if it's not too long
                        if (textToPlay.length > 200) textToPlay = textToPlay.split('.')[0];
                      }
                      playTTS(textToPlay);
                    }}
                    disabled={isPlaying}
                    className={`mt-2 flex items-center gap-1 text-[10px] uppercase font-bold tracking-widest ${isPlaying ? 'text-gray-400' : 'text-[#5A5A40] hover:opacity-70'}`}
                  >
                    {isPlaying ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                    Écouter le modèle
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-black/5 p-3 rounded-2xl rounded-tl-none shadow-sm">
              <Loader2 className="animate-spin text-[#5A5A40]" size={18} />
            </div>
          </div>
        )}
      </div>

      <div className="p-4 bg-white border-t border-black/5">
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 p-2 bg-red-50 border border-red-100 rounded-lg text-xs text-red-600 flex justify-between items-center"
            >
              <div className="flex items-center gap-2">
                <span>{error}</span>
                {error.includes("réseau") && (
                  <button 
                    onClick={() => { setError(null); toggleListening(); }}
                    className="underline font-bold"
                  >
                    Réessayer
                  </button>
                )}
              </div>
              <button onClick={() => setError(null)} className="ml-2 font-bold">✕</button>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex gap-2">
          <button
            onClick={toggleListening}
            disabled={isLoading && !isListening}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
              isListening 
              ? (isLiveMode ? 'bg-red-500 text-white' : 'bg-red-500 text-white animate-pulse') 
              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
            title={isLiveMode ? "Arrêter la session live" : (retryCount > 0 ? `Tentative de reconnexion ${retryCount}/3...` : "Entrée vocale")}
          >
            {isListening ? (retryCount > 0 ? <Loader2 size={18} className="animate-spin" /> : <MicOff size={18} />) : <Mic size={18} />}
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={pronunciationTarget ? "Parlez maintenant..." : "Écrivez votre message en français..."}
            className="flex-1 px-4 py-2 rounded-full border border-black/10 focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/20 transition-all"
          />
          <button
            onClick={() => handleSend()}
            disabled={isLoading}
            className="w-10 h-10 rounded-full bg-[#5A5A40] text-white flex items-center justify-center hover:bg-[#4a4a35] transition-colors disabled:opacity-50"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};
