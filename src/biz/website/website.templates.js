// Starter websites: pick one and every page is filled with sample text to change.
// Each gives 4 pages: Home, About, Services (or Menu / Courses…), Contact.
const T = (en, km) => ({ en, km });
const rid = () => Math.random().toString(36).slice(2, 10);
const blk = (type, data) => ({ id: rid(), type, hidden: false, data });

const DAYS = [
  [T("Monday – Friday", "ច័ន្ទ – សុក្រ"), T("7:00 – 20:00", "7:00 – 20:00")],
  [T("Saturday – Sunday", "សៅរ៍ – អាទិត្យ"), T("8:00 – 18:00", "8:00 – 18:00")],
];

// what changes from one starter to another
const KINDS = {
  cafe: {
    en: "Café",
    km: "ហាងកាហ្វេ",
    theme: "soft",
    hero: [T("Fresh coffee, made with love", "កាហ្វេស្រស់ ធ្វើដោយក្តីស្រលាញ់"), T("Beans from Mondulkiri, roasted every week. Come in, sit down, stay a while.", "គ្រាប់កាហ្វេពីមណ្ឌលគិរី លីងរៀងរាល់សប្តាហ៍។ សូមអញ្ជើញចូលអង្គុយលេង។")],
    third: T("Menu", "ម៉ឺនុយ"),
    services: [
      ["coffee", T("Coffee", "កាហ្វេ"), T("Iced latte, cappuccino and Khmer coffee with condensed milk.", "ឡាតេទឹកកក កាពូឈីណូ និងកាហ្វេខ្មែរទឹកដោះគោ។")],
      ["cake", T("Cakes", "នំខេក"), T("Baked fresh every morning in our kitchen.", "ដុតថ្មីៗរៀងរាល់ព្រឹកនៅក្នុងផ្ទះបាយយើង។")],
      ["wifi", T("Free Wi-Fi", "Wi-Fi ឥតគិតថ្លៃ"), T("A quiet place to work or meet friends.", "កន្លែងស្ងាត់សម្រាប់ធ្វើការ ឬជួបមិត្តភក្តិ។")],
    ],
    prices: [
      [T("Iced latte", "ឡាតេទឹកកក"), "$2.50", T("Fresh milk, double shot", "ទឹកដោះគោស្រស់ ពីរដង")],
      [T("Khmer iced coffee", "កាហ្វេទឹកដោះគោទឹកកក"), "$1.50", T("Strong and sweet", "ខ្លាំង និងផ្អែម")],
      [T("Matcha latte", "ម៉ាចាឡាតេ"), "$2.75", T("Japanese green tea", "តែបៃតងជប៉ុន")],
      [T("Chocolate cake", "នំខេកសូកូឡា"), "$2.00", T("One slice", "មួយចំណិត")],
    ],
    about: T("We opened in 2019 with one small machine and a big dream: good coffee for everyone in our street.", "យើងបើកនៅឆ្នាំ 2019 ជាមួយម៉ាស៊ីនតូចមួយ និងក្តីស្រមៃធំ៖ កាហ្វេល្អសម្រាប់អ្នកជិតខាងទាំងអស់។"),
  },
  shop: {
    en: "Shop",
    km: "ហាង",
    theme: "clean",
    hero: [T("Everything you need, in one place", "អ្វីគ្រប់យ៉ាងដែលអ្នកត្រូវការ នៅកន្លែងតែមួយ"), T("Good products, fair prices and delivery in Phnom Penh.", "ផលិតផលល្អ តម្លៃសមរម្យ និងដឹកជញ្ជូនក្នុងភ្នំពេញ។")],
    third: T("Products", "ផលិតផល"),
    services: [
      ["truck", T("Fast delivery", "ដឹកជញ្ជូនរហ័ស"), T("Same-day delivery in the city.", "ដឹកជញ្ជូនក្នុងថ្ងៃតែមួយក្នុងទីក្រុង។")],
      ["shield", T("Real products", "ផលិតផលពិត"), T("Every item checked before it leaves the shop.", "ពិនិត្យរាល់ទំនិញមុនចេញពីហាង។")],
      ["card", T("Pay your way", "បង់តាមចិត្ត"), T("Cash, ABA, KHQR or card.", "សាច់ប្រាក់ ABA KHQR ឬកាត។")],
    ],
    prices: [
      [T("Rice cooker", "ឆ្នាំងបាយអគ្គិសនី"), "$25", T("1.8 L, 1 year warranty", "1.8 លីត្រ ធានា 1 ឆ្នាំ")],
      [T("Electric fan", "កង្ហារអគ្គិសនី"), "$18", T("3 speeds", "3 ល្បឿន")],
      [T("Water filter", "ធុងចម្រោះទឹក"), "$35", T("With 2 spare filters", "មានតម្រងបម្រុង 2")],
    ],
    about: T("A family shop since 2012. We know our customers by name.", "ហាងគ្រួសារតាំងពីឆ្នាំ 2012។ យើងស្គាល់អតិថិជនតាមឈ្មោះ។"),
  },
  salon: {
    en: "Salon & spa",
    km: "សាឡន និងស្ប៉ា",
    theme: "soft",
    hero: [T("Relax. You deserve it.", "សម្រាក។ អ្នកសមនឹងទទួលបាន។"), T("Hair, nails, massage and facials in a calm, clean place.", "សក់ ក្រចក ម៉ាស្សា និងថែមុខ នៅកន្លែងស្ងប់ស្ងាត់ និងស្អាត។")],
    third: T("Services", "សេវាកម្ម"),
    services: [
      ["scissors", T("Hair", "សក់"), T("Cut, colour and treatment by trained stylists.", "កាត់ ជ្រលក់ និងថែទាំដោយជាងជំនាញ។")],
      ["sparkles", T("Nails", "ក្រចក"), T("Manicure, pedicure and gel nails.", "ថែក្រចកដៃ ជើង និងក្រចកជែល។")],
      ["heart", T("Massage", "ម៉ាស្សា"), T("Khmer, oil and foot massage.", "ម៉ាស្សាខ្មែរ ប្រេង និងជើង។")],
    ],
    prices: [
      [T("Haircut", "កាត់សក់"), "$8", T("Wash and style included", "រួមទាំងកក់ និងរៀបចំ")],
      [T("Gel nails", "ក្រចកជែល"), "$12", T("Hands", "ដៃ")],
      [T("Khmer massage – 60 min", "ម៉ាស្សាខ្មែរ – 60 នាទី"), "$15", T("", "")],
      [T("Facial", "ថែមុខ"), "$20", T("Clean and glow", "សម្អាត និងភ្លឺថ្លា")],
    ],
    about: T("Our team has more than 10 years of experience. We use safe, quality products only.", "ក្រុមរបស់យើងមានបទពិសោធន៍ជាង 10 ឆ្នាំ។ យើងប្រើតែផលិតផលមានគុណភាព និងសុវត្ថិភាព។"),
  },
  school: {
    en: "School & courses",
    km: "សាលា និងវគ្គសិក្សា",
    theme: "bold",
    hero: [T("Learn today, lead tomorrow", "រៀនថ្ងៃនេះ ដឹកនាំថ្ងៃស្អែក"), T("English, computer and maths classes for kids and adults.", "ថ្នាក់អង់គ្លេស កុំព្យូទ័រ និងគណិតវិទ្យា សម្រាប់កុមារ និងមនុស្សពេញវ័យ។")],
    third: T("Courses", "វគ្គសិក្សា"),
    services: [
      ["book", T("Small classes", "ថ្នាក់តូច"), T("No more than 15 students per class.", "មិនលើសពី 15 នាក់ក្នុងមួយថ្នាក់។")],
      ["award", T("Good teachers", "គ្រូល្អ"), T("Trained, patient and friendly.", "មានជំនាញ អត់ធ្មត់ និងរួសរាយ។")],
      ["clock", T("Flexible times", "ម៉ោងបត់បែន"), T("Morning, evening and weekend classes.", "ថ្នាក់ព្រឹក ល្ងាច និងចុងសប្តាហ៍។")],
    ],
    prices: [
      [T("General English – 3 months", "អង់គ្លេសទូទៅ – 3 ខែ"), "$90", T("Levels 1 to 12", "កម្រិត 1 ដល់ 12")],
      [T("Computer basics", "កុំព្យូទ័រមូលដ្ឋាន"), "$60", T("Word, Excel, internet", "Word Excel អ៊ីនធឺណិត")],
      [T("Maths for grade 12", "គណិតវិទ្យាថ្នាក់ទី 12"), "$50", T("Exam preparation", "ត្រៀមប្រឡង")],
    ],
    about: T("Since 2015 we have helped more than 3,000 students reach their goals.", "តាំងពីឆ្នាំ 2015 យើងបានជួយសិស្សជាង 3,000 នាក់ សម្រេចគោលដៅ។"),
  },
  clinic: {
    en: "Clinic",
    km: "គ្លីនិក",
    theme: "clean",
    hero: [T("Caring for your family's health", "ថែទាំសុខភាពគ្រួសាររបស់អ្នក"), T("General check-ups, children's care and lab tests. Open 7 days.", "ពិនិត្យសុខភាពទូទៅ ថែទាំកុមារ និងពិសោធន៍។ បើក 7 ថ្ងៃ។")],
    third: T("Services", "សេវាកម្ម"),
    services: [
      ["stethoscope", T("Check-ups", "ពិនិត្យសុខភាព"), T("For adults and children.", "សម្រាប់មនុស្សពេញវ័យ និងកុមារ។")],
      ["flask", T("Lab tests", "ពិសោធន៍"), T("Results the same day.", "លទ្ធផលក្នុងថ្ងៃតែមួយ។")],
      ["calendar", T("Book ahead", "កក់ទុកមុន"), T("Call or message us to book a time.", "ទូរស័ព្ទ ឬផ្ញើសារមកកក់ម៉ោង។")],
    ],
    prices: [
      [T("General check-up", "ពិនិត្យសុខភាពទូទៅ"), "$10", T("", "")],
      [T("Blood test", "ពិនិត្យឈាម"), "$15", T("Basic panel", "កញ្ចប់មូលដ្ឋាន")],
      [T("Child check-up", "ពិនិត្យកុមារ"), "$8", T("", "")],
    ],
    about: T("Our doctors and nurses are licensed and speak Khmer and English.", "វេជ្ជបណ្ឌិត និងគិលានុបដ្ឋាករបស់យើងមានអាជ្ញាប័ណ្ណ និងនិយាយខ្មែរ អង់គ្លេស។"),
  },
  ngo: {
    en: "NGO & community",
    km: "អង្គការ និងសហគមន៍",
    theme: "clean",
    hero: [T("Together we build a better community", "រួមគ្នាយើងកសាងសហគមន៍ល្អប្រសើរ"), T("Education, clean water and health for families in rural Cambodia.", "ការអប់រំ ទឹកស្អាត និងសុខភាព សម្រាប់គ្រួសារនៅជនបទកម្ពុជា។")],
    third: T("Our work", "ការងាររបស់យើង"),
    services: [
      ["book", T("Education", "ការអប់រំ"), T("Books, classes and scholarships.", "សៀវភៅ ថ្នាក់រៀន និងអាហារូបករណ៍។")],
      ["droplet", T("Clean water", "ទឹកស្អាត"), T("Wells and filters for villages.", "អណ្តូង និងតម្រងទឹកសម្រាប់ភូមិ។")],
      ["heart", T("Health", "សុខភាព"), T("Mobile clinics and health training.", "គ្លីនិកចល័ត និងវគ្គបណ្តុះបណ្តាលសុខភាព។")],
    ],
    prices: [
      [T("School kit for one child", "កញ្ចប់សិក្សាសម្រាប់កុមារម្នាក់"), "$15", T("Bag, books, uniform", "កាបូប សៀវភៅ ឯកសណ្ឋាន")],
      [T("Water filter for one family", "តម្រងទឹកសម្រាប់គ្រួសារមួយ"), "$40", T("", "")],
    ],
    about: T("We are a local organisation working in 12 villages since 2010.", "យើងជាអង្គការក្នុងស្រុក ធ្វើការក្នុង 12 ភូមិ តាំងពីឆ្នាំ 2010។"),
  },
  event: {
    en: "Event",
    km: "ព្រឹត្តិការណ៍",
    theme: "bold",
    hero: [T("The big day is coming", "ថ្ងៃដ៏សំខាន់កំពុងមកដល់"), T("Music, food and fun for the whole family. Save the date!", "តន្ត្រី អាហារ និងការកម្សាន្តសម្រាប់គ្រួសារ។ កុំភ្លេចកាលបរិច្ឆេទ!")],
    third: T("Programme", "កម្មវិធី"),
    services: [
      ["music", T("Live music", "តន្ត្រីផ្ទាល់"), T("Local bands all evening.", "ក្រុមតន្ត្រីក្នុងស្រុកពេញមួយល្ងាច។")],
      ["utensils", T("Street food", "អាហារតាមផ្លូវ"), T("More than 30 food stalls.", "តូបអាហារជាង 30។")],
      ["gift", T("Lucky draw", "ចាប់រង្វាន់"), T("Win prizes every hour.", "ឈ្នះរង្វាន់រៀងរាល់ម៉ោង។")],
    ],
    prices: [
      [T("Entry ticket", "សំបុត្រចូល"), "$3", T("Children under 12 free", "កុមារក្រោម 12 ឆ្នាំ ឥតគិតថ្លៃ")],
      [T("VIP ticket", "សំបុត្រ VIP"), "$10", T("Front seats + drink", "កៅអីខាងមុខ + ភេសជ្ជៈ")],
    ],
    about: T("The festival has brought people together every year since 2016.", "មហោស្រពនេះប្រមូលផ្តុំមនុស្សរៀងរាល់ឆ្នាំ តាំងពីឆ្នាំ 2016។"),
  },
  personal: {
    en: "Personal & portfolio",
    km: "ផ្ទាល់ខ្លួន និងស្នាដៃ",
    theme: "clean",
    hero: [T("Hi, I'm Dara", "សួស្តី ខ្ញុំឈ្មោះ តារា"), T("Designer and photographer in Phnom Penh. Let's make something beautiful.", "អ្នករចនា និងថតរូបនៅភ្នំពេញ។ តោះបង្កើតអ្វីដែលស្អាតជាមួយគ្នា។")],
    third: T("Work", "ស្នាដៃ"),
    services: [
      ["pen", T("Design", "រចនា"), T("Logos, posters and social media.", "ឡូហ្គោ ផូស្ទ័រ និងបណ្តាញសង្គម។")],
      ["camera", T("Photography", "ថតរូប"), T("Products, events and portraits.", "ផលិតផល ព្រឹត្តិការណ៍ និងរូបបុគ្គល។")],
      ["monitor", T("Websites", "គេហទំព័រ"), T("Simple sites for small businesses.", "គេហទំព័រសាមញ្ញសម្រាប់អាជីវកម្មតូច។")],
    ],
    prices: [
      [T("Logo design", "រចនាឡូហ្គោ"), "$80", T("3 ideas, 2 changes", "គំនិត 3 កែ 2 ដង")],
      [T("Product photos (10)", "ថតរូបផលិតផល (10)"), "$50", T("", "")],
    ],
    about: T("I have worked with more than 100 brands in Cambodia and love clean, simple design.", "ខ្ញុំបានធ្វើការជាមួយម៉ាកជាង 100 នៅកម្ពុជា ហើយចូលចិត្តការរចនាស្អាត និងសាមញ្ញ។"),
  },
};
const TEMPLATE_KEYS = Object.keys(KINDS);

// the pages of one starter (blocks are cleaned again before saving)
function templatePages(key) {
  const k = KINDS[key] || KINDS.shop;
  const third = k.third;
  const thirdSlug = { cafe: "menu", shop: "products", school: "courses", ngo: "our-work", event: "programme", personal: "work" }[key] || "services";
  const contactBtn = T("Contact us", "ទាក់ទងយើង");
  return [
    {
      slug: "home",
      title: T("Home", "ទំព័រដើម"),
      home: true,
      blocks: [
        blk("hero", { title: k.hero[0], sub: k.hero[1], btn: third, btn_to: `page:${thirdSlug}`, btn2: contactBtn, btn2_to: "page:contact", align: "center", size: "lg", overlay: "dark" }),
        blk("services", { title: T("Why choose us", "ហេតុអ្វីជ្រើសរើសយើង"), sub: T("", ""), items: k.services.map(([icon, title, text]) => ({ icon, title, text, image: "" })) }),
        blk("numbers", {
          title: T("", ""),
          items: [
            { value: "10+", label: T("Years", "ឆ្នាំ") },
            { value: "5,000+", label: T("Happy customers", "អតិថិជនពេញចិត្ត") },
            { value: "4.9★", label: T("Rating", "ការវាយតម្លៃ") },
          ],
        }),
        blk("gallery", {
          title: T("Gallery", "រូបភាព"),
          cols: "3",
          images: [
            { image: "", caption: T("", "") },
            { image: "", caption: T("", "") },
            { image: "", caption: T("", "") },
          ],
        }),
        blk("quotes", {
          title: T("What people say", "អ្វីដែលអតិថិជននិយាយ"),
          items: [
            { text: T("Friendly people and great quality. I come back every week!", "បុគ្គលិករួសរាយ និងគុណភាពល្អ។ ខ្ញុំមករៀងរាល់សប្តាហ៍!"), name: T("Sreyneang", "ស្រីនាង"), role: T("Customer", "អតិថិជន"), photo: "" },
            { text: T("Fast, clean and good value. Highly recommended.", "លឿន ស្អាត និងសមតម្លៃ។ ណែនាំយ៉ាងខ្លាំង។"), name: T("Vuthy", "វុទ្ធី"), role: T("Customer", "អតិថិជន"), photo: "" },
          ],
        }),
        blk("cta", { title: T("Ready to visit?", "ត្រៀមមកលេងហើយឬនៅ?"), sub: T("We'd love to see you soon.", "យើងរង់ចាំស្វាគមន៍អ្នក។"), btn: contactBtn, btn_to: "page:contact" }),
      ],
    },
    {
      slug: "about",
      title: T("About", "អំពីយើង"),
      blocks: [
        blk("split", { title: T("Our story", "រឿងរ៉ាវរបស់យើង"), body: k.about, image: "", side: "right", btn: T("", ""), btn_to: "" }),
        blk("team", {
          title: T("Meet the team", "ស្គាល់ក្រុមការងារ"),
          people: [
            { name: T("Sokha", "សុខា"), role: T("Owner", "ម្ចាស់"), photo: "" },
            { name: T("Dara", "តារា"), role: T("Manager", "អ្នកគ្រប់គ្រង"), photo: "" },
            { name: T("Lina", "លីណា"), role: T("Staff", "បុគ្គលិក"), photo: "" },
          ],
        }),
        blk("faq", {
          title: T("Questions", "សំណួរ"),
          items: [
            { q: T("Where are you?", "អ្នកនៅឯណា?"), a: T("See the map on our Contact page.", "សូមមើលផែនទីនៅទំព័រទំនាក់ទំនង។") },
            { q: T("How can I pay?", "តើខ្ញុំអាចបង់ប្រាក់យ៉ាងដូចម្តេច?"), a: T("Cash, ABA and KHQR.", "សាច់ប្រាក់ ABA និង KHQR។") },
          ],
        }),
      ],
    },
    {
      slug: thirdSlug,
      title: third,
      blocks: [
        blk("text", { title: third, body: T("Here is what we offer. Prices may change — call us to check.", "នេះជាអ្វីដែលយើងផ្តល់ជូន។ តម្លៃអាចប្រែប្រួល — សូមទូរស័ព្ទមកសួរ។"), align: "center" }),
        blk("prices", { title: T("Prices", "តម្លៃ"), sub: T("", ""), items: k.prices.map(([name, price, desc]) => ({ name, price, desc })), note: T("Prices in US dollars.", "តម្លៃគិតជាដុល្លារ។") }),
        blk("cta", { title: T("Questions?", "មានសំណួរ?"), sub: T("Send us a message and we'll reply quickly.", "ផ្ញើសារមកយើង យើងនឹងឆ្លើយតបយ៉ាងឆាប់។"), btn: contactBtn, btn_to: "page:contact" }),
      ],
    },
    {
      slug: "contact",
      title: T("Contact", "ទំនាក់ទំនង"),
      blocks: [
        blk("contact", { title: T("Send us a message", "ផ្ញើសារមកយើង"), sub: T("We usually reply within a few hours.", "ជាធម្មតាយើងឆ្លើយតបក្នុងរយៈពេលពីរបីម៉ោង។"), phone_field: true, email_field: false, button: T("Send", "ផ្ញើ") }),
        blk("hours", { title: T("Opening hours", "ម៉ោងបើក"), rows: DAYS.map(([day, time]) => ({ day, time })), note: T("", "") }),
        blk("map", { title: T("Find us", "ស្វែងរកយើង"), address: T("Phnom Penh, Cambodia", "ភ្នំពេញ កម្ពុជា"), map_url: "" }),
        blk("social", { title: T("Follow us", "តាមដានយើង") }),
      ],
    },
  ];
}

module.exports = { KINDS, TEMPLATE_KEYS, templatePages };
