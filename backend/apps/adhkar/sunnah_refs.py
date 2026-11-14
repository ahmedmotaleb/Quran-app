"""Authentic Sunnah adhkar to copy from the hadith dataset (see sunnah_build.py). `start`/`end` are search markers
only (diacritics ignored); the stored text is always the source's own. `repetition` only where the narration states it."""
R = lambda category, collection, number, start, end=None, time="any", repetition=None: {  # noqa: E731
    "category": category, "collection": collection, "number": number, "start": start, "end": end or start, "time": time,
    "repetition": repetition}

REFS = [
    # أذكار الصباح
    R("morning", "abudawud", 5068, "اللهم بك اصبحنا", "واليك النشور", "morning"),
    R("morning", "abudawud", 5088, "بسم الله الذي لا يضر مع اسمه شيء", "وهو السميع العليم", "morning", 3),
    R("morning", "muslim", 2726, "سبحان الله وبحمده عدد خلقه", "ومداد كلماته", "morning", 3),
    R("morning", "muslim", 2692, "سبحان الله وبحمده", None, "morning", 100),
    R("morning", "abudawud", 5090, "اللهم عافني في بدني", "لا اله الا انت", "morning", 3),
    # أذكار المساء
    R("evening", "abudawud", 5067, "اللهم فاطر السموات والارض", "وشركه", "evening"),
    R("evening", "muslim", 2709, "اعوذ بكلمات الله التامات من شر ما خلق", None, "evening"),
    R("evening", "tirmidhi", 3391, "اللهم بك امسينا", "واليك النشور", "evening"),
    # أذكار النوم
    R("sleep", "bukhari", 6324, "باسمك اللهم اموت واحيا", None, "sleep"),
    R("sleep", "bukhari", 6320, "باسمك رب وضعت جنبي", "عبادك الصالحين", "sleep"),
    R("sleep", "bukhari", 247, "اللهم اسلمت وجهي اليك", "وبنبيك الذي ارسلت", "sleep"),
    R("sleep", "abudawud", 5045, "اللهم قني عذابك يوم تبعث عبادك", None, "sleep"),
    R("sleep", "muslim", 2713, "اللهم رب السموات ورب الارض", "واغننا من الفقر", "sleep"),
    R("sleep", "muslim", 2715, "الحمد لله الذي اطعمنا وسقانا", "لا كافي له ولا ميوي", "sleep"),
    # أذكار الاستيقاظ
    R("waking", "bukhari", 6312, "الحمد لله الذي احيانا", "واليه النشور", "waking"),
    # الاستغفار
    R("istighfar", "bukhari", 6306, "اللهم انت ربي لا اله الا انت", "لا يغفر الذنوب الا انت"),
    R("istighfar", "bukhari", 6307, "استغفر الله واتوب اليه"),
    R("istighfar", "abudawud", 1516, "رب اغفر لي وتب علي", "التواب الرحيم"),
    # التسبيح والذكر
    R("tasbih", "bukhari", 6406, "سبحان الله العظيم سبحان الله وبحمده"),
    R("tasbih", "tirmidhi", 3464, "سبحان الله العظيم وبحمده"),
    R("dhikr", "muslim", 2137, "سبحان الله والحمد لله ولا اله الا الله والله اكبر"),
    R("dhikr", "bukhari", 6403, "لا اله الا الله وحده لا شريك له", "وهو على كل شيء قدير", repetition=100),
    R("dhikr", "bukhari", 6384, "لا حول ولا قوه الا بالله"),
    # الصلاة على النبي ﷺ
    R("salawat", "bukhari", 3370, "اللهم صل على محمد", "كما باركت على ابراهيم وعلى ال ابراهيم انك حميد مجيد"),
    # أدعية من السنة
    R("sunnah_dua", "muslim", 2721, "اللهم اني اسالك الهدى والتقى والعفاف والغنى"),
    R("sunnah_dua", "tirmidhi", 2140, "يا مقلب القلوب ثبت قلبي على دينك"),
    R("sunnah_dua", "bukhari", 6369, "اللهم اني اعوذ بك من الهم والحزن", "وغلبه الرجال"),
    R("sunnah_dua", "abudawud", 1522, "اللهم اعني على ذكرك وشكرك وحسن عبادتك"),
    R("sunnah_dua", "muslim", 2739, "اللهم اني اعوذ بك من زوال نعمتك", "وجميع سخطك"),
    R("sunnah_dua", "muslim", 483, "اللهم اغفر لي ذنبي كله", "وسره"),
    R("sunnah_dua", "muslim", 2720, "اللهم اصلح لي ديني الذي هو عصمه امري", "من كل شر"),
    R("sunnah_dua", "tirmidhi", 3513, "اللهم انك عفو", "فاعف عني"),
    # فضل القرآن (أحاديث)
    R("quran_motivation", "bukhari", 5027, "خيركم من تعلم القران وعلمه"),
    R("quran_motivation", "muslim", 804, "اقرءوا القران فانه ياتي يوم القيامه شفيعا لاصحابه"),
    R("quran_motivation", "muslim", 798, "الماهر بالقران", "له اجران"),
    R("quran_motivation", "tirmidhi", 2910, "من قرا حرفا من كتاب الله", "بعشر امثالها"),
]
