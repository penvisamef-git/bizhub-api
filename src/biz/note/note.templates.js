// Ready-made notes: POST /notes { template, lang } fills the title + blocks (Khmer by default).
// homework + signup open in "collect" mode (each person sends their own row).
const T = {
  blank: { level: null, en: { title: "", blocks: [["p", ""]] }, km: { title: "", blocks: [["p", ""]] } },
  meeting: {
    level: "reply",
    en: { title: "Meeting notes", blocks: [["h", "Date & people"], ["p", ""], ["h", "Agenda"], ["bullet", ""], ["h", "Decisions"], ["bullet", ""], ["h", "To do"], ["check", ""]] },
    km: { title: "កំណត់ហេតុប្រជុំ", blocks: [["h", "កាលបរិច្ឆេទ និងអ្នកចូលរួម"], ["p", ""], ["h", "របៀបវារៈ"], ["bullet", ""], ["h", "សេចក្ដីសម្រេច"], ["bullet", ""], ["h", "ការងារត្រូវធ្វើ"], ["check", ""]] },
  },
  homework: {
    level: "collect",
    en: { title: "Homework", blocks: [["h", "What to do"], ["p", ""], ["h", "Due date"], ["p", ""], ["quote", "Send your work below: write your name and attach a photo or file."]] },
    km: { title: "កិច្ចការផ្ទះ", blocks: [["h", "ការងារត្រូវធ្វើ"], ["p", ""], ["h", "ថ្ងៃផុតកំណត់"], ["p", ""], ["quote", "សូមផ្ញើកិច្ចការខាងក្រោម៖ សរសេរឈ្មោះ ហើយភ្ជាប់រូបថត ឬឯកសារ។"]] },
  },
  checklist: {
    level: "edit",
    en: { title: "Checklist", blocks: [["check", ""], ["check", ""], ["check", ""]] },
    km: { title: "បញ្ជីត្រួតពិនិត្យ", blocks: [["check", ""], ["check", ""], ["check", ""]] },
  },
  room_rent: {
    level: "reply",
    en: { title: "Room rent", blocks: [["h", "Room"], ["p", ""], ["h", "Monthly rent"], ["p", ""], ["h", "Rules"], ["bullet", ""], ["quote", "Each month: send the water / electricity meter photos and the payment slip below."]] },
    km: { title: "ជួលបន្ទប់", blocks: [["h", "បន្ទប់"], ["p", ""], ["h", "ថ្លៃជួលប្រចាំខែ"], ["p", ""], ["h", "បទបញ្ជា"], ["bullet", ""], ["quote", "រៀងរាល់ខែ៖ សូមផ្ញើរូបនាឡិកាទឹក / ភ្លើង និងបង្កាន់ដៃបង់ប្រាក់ខាងក្រោម។"]] },
  },
  repair_job: {
    level: "reply",
    en: { title: "Repair job", blocks: [["h", "Customer"], ["p", ""], ["h", "Item / problem"], ["p", ""], ["h", "Progress"], ["check", "Checked"], ["check", "Repaired"], ["check", "Ready to pick up"], ["h", "Price"], ["p", ""]] },
    km: { title: "ការងារជួសជុល", blocks: [["h", "អតិថិជន"], ["p", ""], ["h", "ឧបករណ៍ / បញ្ហា"], ["p", ""], ["h", "ដំណើរការ"], ["check", "បានពិនិត្យ"], ["check", "បានជួសជុល"], ["check", "រួចរាល់ មកយកបាន"], ["h", "តម្លៃ"], ["p", ""]] },
  },
  trip: {
    level: "edit",
    en: { title: "Trip plan", blocks: [["h", "Where & when"], ["p", ""], ["h", "Plan"], ["bullet", "Day 1: "], ["bullet", "Day 2: "], ["h", "Bring"], ["check", ""], ["h", "Money"], ["p", ""]] },
    km: { title: "ផែនការដំណើរកម្សាន្ត", blocks: [["h", "ទីកន្លែង និងពេលវេលា"], ["p", ""], ["h", "ផែនការ"], ["bullet", "ថ្ងៃទី១៖ "], ["bullet", "ថ្ងៃទី២៖ "], ["h", "របស់ត្រូវយក"], ["check", ""], ["h", "ប្រាក់"], ["p", ""]] },
  },
  signup: {
    level: "collect",
    en: { title: "Sign-up list", blocks: [["h", "What"], ["p", ""], ["h", "When & where"], ["p", ""], ["quote", "Add your name below to join."]] },
    km: { title: "បញ្ជីចុះឈ្មោះ", blocks: [["h", "កម្មវិធី"], ["p", ""], ["h", "ពេលវេលា និងទីកន្លែង"], ["p", ""], ["quote", "សូមដាក់ឈ្មោះរបស់អ្នកខាងក្រោមដើម្បីចូលរួម។"]] },
  },
};
const TEMPLATES = Object.keys(T);
const blockId = () => Math.random().toString(36).slice(2, 10);

// → { title, blocks, level } (level null = the book's default)
function fromTemplate(key, lang = "km") {
  const t = T[key] || T.blank;
  const words = t[lang === "en" ? "en" : "km"];
  return { title: words.title, blocks: words.blocks.map(([type, text]) => ({ id: blockId(), t: type, text, done: false, file_id: "" })), level: t.level };
}

module.exports = { TEMPLATES, fromTemplate, blockId };
