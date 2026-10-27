"""Bulgarian text generators for synthetic samples: names, dates, ЕГН, document
numbers, field labels, addresses and TD1 MRZ lines.

Every value is generated from a seeded random.Random, so a seed reproduces the same
samples. All people generated here are fictitious.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

# ── Transliteration: Streamlined System (State Gazette 19/2009) ──────────────
# Same rules as shared/src/providers/ocr/bg/transliteration.ts.

BG_TO_LATIN = {
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ж': 'ZH', 'З': 'Z', 'И': 'I', 'Й': 'Y',
    'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
    'Ф': 'F', 'Х': 'H', 'Ц': 'TS', 'Ч': 'CH', 'Ш': 'SH', 'Щ': 'SHT', 'Ъ': 'A', 'Ь': 'Y', 'Ю': 'YU', 'Я': 'YA',
}


def transliterate(word: str) -> str:
    upper = word.upper()
    if upper == 'БЪЛГАРИЯ':
        return 'BULGARIA'
    out = []
    for i, ch in enumerate(upper):
        if ch == 'Я' and i == len(upper) - 1 and i > 0 and upper[i - 1] == 'И':
            out.append('A')
        else:
            out.append(BG_TO_LATIN.get(ch, ch))
    return ''.join(out)


def transliterate_text(text: str) -> str:
    return ' '.join(transliterate(w) for w in text.split(' '))


# ── Names (common Bulgarian names; combinations are fictitious) ──────────────

MALE_GIVEN = ['ГЕОРГИ', 'ИВАН', 'ДИМИТЪР', 'НИКОЛАЙ', 'ПЕТЪР', 'ХРИСТО', 'СТОЯН', 'ТОДОР', 'АЛЕКСАНДЪР',
              'ВАСИЛ', 'КРАСИМИР', 'ЙОРДАН', 'ЦВЕТАН', 'ЖИВКО', 'ЩЕРЮ', 'ЮЛИЯН', 'ЗДРАВКО', 'ЧАВДАР']
FEMALE_GIVEN = ['МАРИЯ', 'ИВАНКА', 'ЕЛЕНА', 'ЙОРДАНКА', 'ПЕНКА', 'ДЕСИСЛАВА', 'НАДЕЖДА', 'ЦВЕТЕЛИНА',
                'ЖИВКА', 'ЮЛИЯ', 'ЗОРНИЦА', 'ЩЕРЯНА', 'ГЕРГАНА', 'СЛАВИНА', 'МАРИЦА', 'ВЕСЕЛИНА', 'РАДКА']
FATHER_ROOTS = ['ГЕОРГИЕВ', 'ИВАНОВ', 'ДИМИТРОВ', 'НИКОЛОВ', 'ПЕТРОВ', 'ХРИСТОВ', 'СТОЯНОВ', 'ТОДОРОВ',
                'ВАСИЛЕВ', 'ЙОРДАНОВ', 'ЦВЕТАНОВ', 'КРАСИМИРОВ', 'РАДНЕВ', 'ЖЕЛЯЗКОВ']
SURNAME_ROOTS = ['ИВАНОВ', 'ГЕОРГИЕВ', 'ДИМИТРОВ', 'ПЕТРОВ', 'НИКОЛОВ', 'ХРИСТОВ', 'СТОЯНОВ', 'ТОДОРОВ',
                 'ПОПОВ', 'КОЛЕВ', 'ЯНКОВ', 'ЖЕЛЕВ', 'ЦОНЕВ', 'ШИШКОВ', 'ЧОЛАКОВ', 'ЩЕРЕВ', 'ЮРУКОВ', 'ЗАХАРИЕВ']

CITIES = ['СОФИЯ', 'ПЛОВДИВ', 'ВАРНА', 'БУРГАС', 'РУСЕ', 'СТАРА ЗАГОРА', 'ПЛЕВЕН', 'ШУМЕН', 'ЯМБОЛ',
          'ХАСКОВО', 'ПЕРНИК', 'ВЕЛИКО ТЪРНОВО', 'ГАБРОВО', 'КЮСТЕНДИЛ', 'ДОБРИЧ', 'СЛИВЕН']
STREETS = ['ВАСИЛ ЛЕВСКИ', 'ХРИСТО БОТЕВ', 'ЦАР БОРИС III', 'ГЕН. ГУРКО', 'ШИПКА', 'ОБОРИЩЕ', 'ЧЕРНИ ВРЪХ',
           'ВИТОША', 'КНЯЗ БОРИС I', 'ИВАН ВАЗОВ', 'ЯВОРОВ', 'ЦАРИГРАДСКО ШОСЕ']
EYE_COLORS = [('КАФЯВИ', 'BROWN'), ('СИНИ', 'BLUE'), ('ЗЕЛЕНИ', 'GREEN'), ('СИВИ', 'GREY'), ('ЧЕРНИ', 'BLACK')]

# Printed labels on Bulgarian identity documents (Cyrillic / English)
LABELS = [
    'Фамилия/Surname', 'Име/Name', 'Презиме/Father\'s name', 'Гражданство/Nationality',
    'Дата на раждане/Date of birth', 'Пол/Sex', 'ЕГН/Personal No', 'Валидност/Date of expiry',
    '№ на документа/Document number', 'Подпис/Signature', 'Място на раждане/Place of birth',
    'Постоянен адрес/Residence', 'Ръст/Height', 'Цвят на очите/Color of eyes', 'Издаден от/Authority',
    'Дата на издаване/Date of issue', 'РЕПУБЛИКА БЪЛГАРИЯ', 'REPUBLIC OF BULGARIA', 'ЛИЧНА КАРТА',
    'IDENTITY CARD', 'ЕВРОПЕЙСКИ СЪЮЗ', 'EUROPEAN UNION', 'МВР', 'MoI BGR', 'БЪЛГАРИЯ/BGR', 'Ж/F', 'М/M',
]


def female_form(name: str) -> str:
    return name + 'А' if name.endswith(('ОВ', 'ЕВ')) else name


def person(rng: random.Random) -> dict:
    female = rng.random() < 0.5
    given = rng.choice(FEMALE_GIVEN if female else MALE_GIVEN)
    father = rng.choice(FATHER_ROOTS)
    surname = rng.choice(SURNAME_ROOTS)
    if female:
        father, surname = female_form(father), female_form(surname)
    dob = date(1940, 1, 1) + timedelta(days=rng.randrange(0, 365 * 64))
    return {'sex': 'F' if female else 'M', 'given': given, 'father': father, 'surname': surname, 'dob': dob}


# ── ЕГН ──────────────────────────────────────────────────────────────────────

EGN_WEIGHTS = [2, 4, 8, 5, 10, 9, 7, 3, 6]


def egn(dob: date, sex: str, rng: random.Random) -> str:
    month = dob.month + (40 if dob.year >= 2000 else 20 if dob.year < 1900 else 0)
    region = rng.randrange(0, 100)
    ninth = rng.randrange(0, 10, 2) if sex == 'M' else rng.randrange(1, 10, 2)
    body = f'{dob.year % 100:02d}{month:02d}{dob.day:02d}{region:02d}{ninth}'
    check = sum(int(d) * w for d, w in zip(body, EGN_WEIGHTS)) % 11 % 10
    return body + str(check)


def egn_valid(value: str) -> bool:
    if len(value) != 10 or not value.isdigit():
        return False
    return sum(int(d) * w for d, w in zip(value[:9], EGN_WEIGHTS)) % 11 % 10 == int(value[9])


# ── Document numbers and dates ───────────────────────────────────────────────

def document_number(rng: random.Random, generation: str) -> str:
    if generation == 'id_card_2024':
        return ''.join(rng.choice('ABCEHKMPTX') for _ in range(2)) + f'{rng.randrange(10**7):07d}'
    return f'{rng.randrange(10**9):09d}'


def dmy(d: date) -> str:
    return d.strftime('%d.%m.%Y')


# ── TD1 MRZ ──────────────────────────────────────────────────────────────────

def _cd(s: str) -> str:
    total = 0
    for i, ch in enumerate(s):
        v = 0 if ch == '<' else int(ch) if ch.isdigit() else ord(ch) - 55
        total += v * (7, 3, 1)[i % 3]
    return str(total % 10)


def mrz_td1(p: dict, number: str, expiry: date, personal: str) -> list[str]:
    num = number.ljust(9, '<')[:9]
    line1 = f'IDBGR{num}{_cd(num)}'.ljust(30, '<')
    dob = p['dob'].strftime('%y%m%d')
    exp = expiry.strftime('%y%m%d')
    part = f'{dob}{_cd(dob)}{p["sex"]}{exp}{_cd(exp)}BGR{personal.ljust(11, "<")}'
    line2 = part + _cd(line1[5:30] + part[0:7] + part[8:15] + part[18:29])
    names = f'{transliterate(p["surname"])}<<{transliterate(p["given"])}<{transliterate(p["father"])}'
    line3 = names.replace(' ', '<').ljust(30, '<')[:30]
    return [line1, line2, line3]


# ── Text sample kinds ────────────────────────────────────────────────────────

KINDS = ('name_cyrillic', 'name_latin', 'labeled_field', 'date', 'egn', 'document_number', 'mrz',
         'label', 'address', 'place', 'eye_color')


def sample_text(rng: random.Random, kind: str) -> str:
    p = person(rng)
    generation = rng.choice(['id_card_2010', 'id_card_2024'])
    if kind == 'name_cyrillic':
        return rng.choice([p['surname'], p['given'], p['father'], f'{p["given"]} {p["father"]} {p["surname"]}'])
    if kind == 'name_latin':
        return transliterate_text(rng.choice([p['surname'], p['given'], f'{p["given"]} {p["father"]} {p["surname"]}']))
    if kind == 'labeled_field':
        return rng.choice([f'Фамилия/Surname {p["surname"]}', f'Име/Name {p["given"]}',
                           f'ЕГН/Personal No {egn(p["dob"], p["sex"], rng)}', f'Дата на раждане/Date of birth {dmy(p["dob"])}'])
    if kind == 'date':
        return dmy(p['dob'] if rng.random() < 0.5 else date.today() + timedelta(days=rng.randrange(-3650, 3650)))
    if kind == 'egn':
        return egn(p['dob'], p['sex'], rng)
    if kind == 'document_number':
        return document_number(rng, generation)
    if kind == 'mrz':
        expiry = p['dob'] + timedelta(days=365 * rng.randrange(20, 60))
        return rng.choice(mrz_td1(p, document_number(rng, generation), expiry, egn(p['dob'], p['sex'], rng)))
    if kind == 'label':
        return rng.choice(LABELS)
    if kind == 'address':
        city = rng.choice(CITIES)
        return rng.choice([f'обл.{city} общ.{city} гр.{city}', f'ул.{rng.choice(STREETS)} {rng.randrange(1, 200)} ет.{rng.randrange(1, 15)} ап.{rng.randrange(1, 90)}'])
    if kind == 'place':
        city = rng.choice(CITIES)
        return f'{city}/{transliterate_text(city)}'
    if kind == 'eye_color':
        return '/'.join(rng.choice(EYE_COLORS))
    raise ValueError(f'unknown kind {kind}')
