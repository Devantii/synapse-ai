// Interface language (English / हिन्दी). Translates fixed interface text as it is drawn; never what people
// write (posts, replies, chat, task names, names). Add a language by adding a dictionary below.
const LANGS = { en: 'English', hi: 'हिन्दी' };

const HI = {
  // navigation
  'Today': 'आज', 'Rooms': 'रूम', 'Community': 'कम्युनिटी', 'Screen': 'स्क्रीन', 'Screen time': 'स्क्रीन टाइम', 'time': 'टाइम',
  'Progress': 'प्रगति', 'Insights': 'इनसाइट्स', 'Garden': 'बगीचा', 'Privacy': 'प्राइवेसी', 'Admin': 'एडमिन', 'Sign out': 'साइन आउट', 'Install app': 'ऐप इंस्टॉल करें',
  // auth
  'Sign in': 'साइन इन', 'Create account': 'अकाउंट बनाएँ', 'Username': 'यूज़रनेम', 'Password': 'पासवर्ड', 'Your name': 'आपका नाम',
  'At least 8 characters.': 'कम से कम 8 अक्षर।', 'or use a username': 'या यूज़रनेम से',
  'Focus in blocks.': 'टुकड़ों में फ़ोकस करें।', 'Rest on purpose.': 'सोच-समझकर आराम करें।', 'Notice the drift.': 'भटकाव को पहचानें।',
  // timer / today
  'Ready to focus': 'फ़ोकस के लिए तैयार', 'Break is ready': 'ब्रेक तैयार है', 'Growing. Stay with it.': 'पौधा बढ़ रहा है। लगे रहें।',
  'Rest. Look away from the screen.': 'आराम करें। स्क्रीन से नज़र हटाएँ।', 'This one wilted. Try a shorter block.': 'यह मुरझा गया। छोटा ब्लॉक आज़माएँ।',
  'Give up': 'छोड़ दें', 'End break': 'ब्रेक खत्म करें', 'Take a break instead': 'इसके बजाय ब्रेक लें', 'Skip break': 'ब्रेक छोड़ें',
  'Got distracted?': 'ध्यान भटका?', 'Phone': 'फ़ोन', 'Social media': 'सोशल मीडिया', 'Messages': 'मैसेज', 'Wandering thoughts': 'भटकते विचार',
  'Someone interrupted': 'किसी ने टोका', 'Noise': 'शोर', 'Tired or hungry': 'थकान या भूख', 'Other': 'अन्य',
  'What are you working on?': 'आप किस पर काम कर रहे हैं?', 'Optional': 'वैकल्पिक',
  'focused today': 'आज फ़ोकस', 'breaks taken': 'ब्रेक लिए', 'day streak': 'दिन की स्ट्रीक', 'Daily focus goal': 'रोज़ का फ़ोकस लक्ष्य', 'Daily goal reached': 'आज का लक्ष्य पूरा',
  "Today's tasks": 'आज के काम', "Today's sessions": 'आज के सेशन', 'Add': 'जोड़ें', 'Focus': 'फ़ोकस', 'Break': 'ब्रेक', 'Delete': 'हटाएँ',
  'Sounds': 'आवाज़ें', 'Lo-fi music': 'लो-फ़ाई संगीत', 'Rain': 'बारिश', 'Waves': 'लहरें', 'Wind': 'हवा', 'Brown noise': 'ब्राउन नॉइज़', 'Off': 'बंद',
  'Turn on': 'चालू करें', 'Early warning.': 'पहली चेतावनी।',
  // rooms
  'Focus rooms': 'फ़ोकस रूम', 'All rooms': 'सभी रूम', 'Here now': 'अभी यहाँ', 'Group timer': 'ग्रुप टाइमर', 'Focus along': 'साथ में फ़ोकस करें',
  'Take the break too': 'आप भी ब्रेक लें', 'Stop': 'रोकें', 'Join with camera': 'कैमरे के साथ जुड़ें', 'Join without camera': 'बिना कैमरे के जुड़ें',
  'Leave call': 'कॉल छोड़ें', 'Camera on': 'कैमरा चालू', 'Camera off': 'कैमरा बंद', 'Mic on': 'माइक चालू', 'Mic off': 'माइक बंद',
  'in this room': 'इस रूम में', 'in rooms today': 'आज रूम में', 'Send': 'भेजें', 'Reply': 'जवाब दें', 'Cancel': 'रद्द करें', 'Here': 'मौजूद',
  'Nobody here yet': 'अभी कोई नहीं', "This week's focus": 'इस हफ़्ते का फ़ोकस', 'Show me': 'मुझे दिखाएँ', 'Group focus': 'ग्रुप फ़ोकस', 'Group break': 'ग्रुप ब्रेक',
  // community
  'Check in': 'चेक-इन', 'Post check-in': 'चेक-इन पोस्ट करें', "What's going on?": 'क्या चल रहा है?', 'Calm': 'शांत', 'Focused': 'केंद्रित', 'Proud': 'गर्वित',
  'Tired': 'थका हुआ', 'Stressed': 'तनाव में', 'Hopeful': 'आशावान', 'Cheer': 'शाबाशी', 'Hug': 'झप्पी', 'Same here': 'मेरा भी यही हाल',
  'Load older check-ins': 'पुराने चेक-इन देखें', 'Accountability buddies': 'जवाबदेही साथी', 'Add buddy': 'साथी जोड़ें', 'Nudge': 'याद दिलाएँ',
  'Accept': 'स्वीकार करें', 'Decline': 'मना करें', 'Remove': 'हटाएँ', 'Report': 'रिपोर्ट करें', 'Hide this post': 'यह पोस्ट छिपाएँ',
  'Block this person': 'इस व्यक्ति को ब्लॉक करें', 'Report this': 'इसकी रिपोर्ट करें', 'Send report': 'रिपोर्ट भेजें', 'Anything else?': 'कुछ और?',
  'Spam or advertising': 'स्पैम या विज्ञापन', 'Harassment or bullying': 'उत्पीड़न या धमकाना', 'Hate or discrimination': 'नफ़रत या भेदभाव',
  'Self-harm or suicide risk': 'खुद को नुकसान या आत्महत्या का खतरा', 'Sexual content': 'यौन सामग्री', 'Something else': 'कुछ और',
  // screen time / progress
  'Daily limits': 'रोज़ की सीमाएँ', 'Focus calendar': 'फ़ोकस कैलेंडर', 'Your week in review': 'आपका हफ़्ता', 'days with focus': 'फ़ोकस वाले दिन',
  'tasks done': 'काम पूरे', 'average sleep': 'औसत नींद', 'For next week:': 'अगले हफ़्ते के लिए:', 'focused': 'फ़ोकस किया',
  // insights
  'Overview': 'सारांश', 'Trends': 'रुझान', 'Early warning': 'पहली चेतावनी', 'Suggestions for this week': 'इस हफ़्ते के सुझाव',
  'Your personal patterns': 'आपके निजी पैटर्न', 'What influenced the score': 'स्कोर पर किसका असर पड़ा', 'What pulls you away': 'आपका ध्यान किससे भटकता है',
  'How are you today?': 'आज आप कैसे हैं?', 'Energy': 'ऊर्जा', 'Stress': 'तनाव', 'Sleep': 'नींद', 'Hours slept last night': 'कल रात कितने घंटे सोए',
  'Save check-in': 'चेक-इन सेव करें', 'Update check-in': 'चेक-इन अपडेट करें', 'Ask the coach': 'कोच से पूछें', 'Ask': 'पूछें',
  'Your week looks balanced': 'आपका हफ़्ता संतुलित दिखता है', 'Some strain is showing': 'कुछ खिंचाव दिख रहा है', 'Your patterns point to overload': 'आपके पैटर्न ज़्यादा बोझ दिखाते हैं',
  'Focus per day': 'रोज़ का फ़ोकस', 'Screen time per day': 'रोज़ का स्क्रीन टाइम', 'When you focus': 'आप कब फ़ोकस करते हैं', 'Energy and stress': 'ऊर्जा और तनाव',
  'Time in study rooms': 'स्टडी रूम में समय', 'Distractions logged': 'दर्ज भटकाव', 'in study rooms': 'स्टडी रूम में', 'average sleep ': 'औसत नींद',
  'Insights are off': 'इनसाइट्स बंद हैं', 'Turn on insights': 'इनसाइट्स चालू करें', 'Turn on and try with sample data': 'चालू करें और सैंपल डेटा से आज़माएँ',
  'Try with sample data': 'सैंपल डेटा से आज़माएँ', 'Remove sample data': 'सैंपल डेटा हटाएँ', 'Fuzzy rules that fired': 'लागू हुए फ़ज़ी नियम', 'All measured patterns': 'सभी मापे गए पैटर्न',
  'Balanced (under 40)': 'संतुलित (40 से कम)', 'Strained': 'खिंचाव', 'At risk (65+)': 'जोखिम (65+)',
  // privacy
  'Privacy and data': 'प्राइवेसी और डेटा', 'Weekly email report': 'साप्ताहिक ईमेल रिपोर्ट', 'Send me the weekly report': 'मुझे साप्ताहिक रिपोर्ट भेजें',
  "Preview this week's email": 'इस हफ़्ते का ईमेल देखें', 'Send me one now': 'अभी एक भेजें', 'Blocked people': 'ब्लॉक किए गए लोग', 'Unblock': 'अनब्लॉक करें',
  'Sign-in methods': 'साइन-इन के तरीके', 'Delete account': 'अकाउंट हटाएँ', 'Delete my account': 'मेरा अकाउंट हटाएँ', 'Download my data': 'मेरा डेटा डाउनलोड करें',
  'Save focus activity': 'फ़ोकस गतिविधि सेव करें', 'Save screen-time data': 'स्क्रीन-टाइम डेटा सेव करें', 'AI wellbeing insights': 'AI वेलबीइंग इनसाइट्स',
  'Show my name in the community': 'कम्युनिटी में मेरा नाम दिखाएँ', 'Done': 'हो गया', 'Close': 'बंद करें', 'Save': 'सेव करें', 'Change': 'बदलें', 'Copy': 'कॉपी करें',
  'Moderation': 'मॉडरेशन', 'Keep it': 'रहने दें', 'Remove and suspend author': 'हटाएँ और लेखक को निलंबित करें', 'Suspended accounts': 'निलंबित अकाउंट', 'Lift suspension': 'निलंबन हटाएँ',
  'Language': 'भाषा',
  // common sentences
  'Work in blocks and take the break when the timer offers it.': 'टुकड़ों में काम करें और टाइमर कहे तो ब्रेक लें।',
  "It's late. A short wind-down session is better than a long push.": 'देर हो गई है। लंबी मेहनत से बेहतर है एक छोटा शांत सेशन।',
  'Plan the day in a few tasks, then press Focus on one to start a block for it.': 'दिन को कुछ कामों में बाँटें, फिर किसी एक पर फ़ोकस दबाकर ब्लॉक शुरू करें।',
  'No sessions yet today. A 15-minute block is a good way in.': 'आज अभी कोई सेशन नहीं। 15 मिनट का ब्लॉक अच्छी शुरुआत है।',
  'Add a task, e.g. Revise chapter 3': 'काम जोड़ें, जैसे अध्याय 3 दोहराना',
  'Chapter 3 notes': 'अध्याय 3 के नोट्स',
  'Study together on camera.': 'कैमरे पर साथ पढ़ें।',
  "Your camera and mic are used only after you click. Best for up to 6 people on the call.": 'कैमरा और माइक आपके क्लिक करने के बाद ही चालू होते हैं। कॉल में 6 लोगों तक के लिए सबसे अच्छा।',
  'Start a block for the whole room. Everyone sees the same countdown and can focus along.': 'पूरे रूम के लिए ब्लॉक शुरू करें। सबको एक ही उलटी गिनती दिखेगी और सब साथ फ़ोकस कर सकते हैं।',
  "No messages yet. Say what you're working on so others know you're here.": 'अभी कोई मैसेज नहीं। बताइए आप किस पर काम कर रहे हैं ताकि दूसरों को पता चले आप यहाँ हैं।',
  "Say what you're starting on": 'बताइए आप क्या शुरू कर रहे हैं',
  'Work alongside other people. Study on camera with others, chat, or just work quietly together. Camera and mic only start when you choose.': 'दूसरों के साथ काम करें। कैमरे पर साथ पढ़ें, चैट करें या चुपचाप साथ काम करें। कैमरा और माइक तभी चालू होते हैं जब आप चाहें।',
  "Short check-ins from people working on their screen habits. Be kind; there's no follower count here.": 'स्क्रीन की आदतों पर काम कर रहे लोगों के छोटे चेक-इन। दयालु रहें; यहाँ फ़ॉलोअर की गिनती नहीं होती।',
  'Phone stayed in the other room for the whole morning block.': 'पूरे सुबह के ब्लॉक में फ़ोन दूसरे कमरे में रहा।',
  'How your focus, screen time, mood and sleep moved over the last two weeks.': 'पिछले दो हफ़्तों में आपका फ़ोकस, स्क्रीन टाइम, मूड और नींद कैसे बदले।',
  'Private. Only you and the insights model see this.': 'निजी। इसे सिर्फ़ आप और इनसाइट्स मॉडल देखते हैं।',
  '1 drained, 5 full of energy': '1 थका हुआ, 5 ऊर्जा से भरपूर', '1 relaxed, 5 overwhelmed': '1 आराम में, 5 बहुत परेशान',
  'I keep scrolling at night. What should I try?': 'मैं रात को स्क्रॉल करता रहता हूँ। क्या करूँ?',
  'Write a kind reply': 'प्यार से जवाब लिखें', 'Their username': 'उनका यूज़रनेम',
  'focus a day (14-day average)': 'रोज़ का फ़ोकस (14 दिन का औसत)', 'screen time a day': 'रोज़ का स्क्रीन टाइम', 'Sleep ': 'नींद',
  'trees grown': 'पेड़ उगे', 'points': 'पॉइंट',
};

// Text with numbers or names inside.
const HI_PATTERNS = [
  [/^Good morning, (.+)\.$/, 'सुप्रभात, $1।'], [/^Good afternoon, (.+)\.$/, 'नमस्ते, $1।'], [/^Good evening, (.+)\.$/, 'शुभ संध्या, $1।'],
  [/^Start (\d+)-minute focus$/, '$1 मिनट का फ़ोकस शुरू करें'], [/^Start (\d+)-minute break$/, '$1 मिनट का ब्रेक शुरू करें'],
  [/^(\d+) min$/, '$1 मिनट'], [/^(\d+) blocks?$/, '$1 ब्लॉक'], [/^Focus (\d+)$/, 'फ़ोकस $1'], [/^Break (\d+)$/, 'ब्रेक $1'],
  [/^Start group (focus|break) \((\d+) min\)$/, (m, k, n) => `ग्रुप ${k === 'focus' ? 'फ़ोकस' : 'ब्रेक'} शुरू करें (${n} मिनट)`],
  [/^Level (\d+)$/, 'लेवल $1'], [/^Use (\d+) min$/, '$1 मिनट रखें'], [/^Reply (\d+)$/, 'जवाब $1'],
];

const DICTS = { hi: { words: HI, patterns: HI_PATTERNS } };
const SKIP = 'script,style,textarea,code,pre,.bubble,.post > p,.reply p,blockquote,.task-title,.lb-name,.quote,[data-no-i18n],#who,.tile-name span,.f-icon';

let lang = 'en';
try { lang = localStorage.getItem('synapse.lang') || (navigator.language || '').toLowerCase().startsWith('hi') && 'hi' || 'en'; } catch {}
if (!LANGS[lang]) lang = 'en';

function translateString(s, d) {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const hit = d.words[trimmed];
  if (hit) return s.replace(trimmed, hit);
  for (const [re, rep] of d.patterns) if (re.test(trimmed)) return s.replace(trimmed, trimmed.replace(re, rep));
  return null;
}

function translateTree(root, d) {
  if (!root || root.nodeType === 3 && root.parentElement?.closest(SKIP)) return;
  if (root.nodeType === 3) { const t = translateString(root.nodeValue, d); if (t != null && t !== root.nodeValue) root.nodeValue = t; return; }
  if (root.nodeType !== 1 || root.closest?.(SKIP)) return;
  for (const a of ['placeholder', 'aria-label', 'title']) {
    const v = root.getAttribute?.(a);
    if (v) { const t = translateString(v, d); if (t != null && t !== v) root.setAttribute(a, t); }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) { const t = translateString(n.nodeValue, d); if (t != null && t !== n.nodeValue) n.nodeValue = t; }
    else for (const a of ['placeholder', 'aria-label', 'title']) {
      const v = n.getAttribute(a);
      if (v) { const t = translateString(v, d); if (t != null && t !== v) n.setAttribute(a, t); }
    }
  }
}

export function currentLang() { return lang; }

export function initI18n() {
  document.documentElement.lang = lang;
  // Language pickers anywhere on the page.
  for (const sel of document.querySelectorAll('.lang-pick')) {
    sel.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === lang ? 'selected' : ''}>${v}</option>`).join('');
    sel.addEventListener('change', () => { try { localStorage.setItem('synapse.lang', sel.value); } catch {} location.reload(); });
  }
  const d = DICTS[lang];
  if (!d) return;
  translateTree(document.body, d);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') translateTree(m.target, d);
      else m.addedNodes.forEach((n) => translateTree(n, d));
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
