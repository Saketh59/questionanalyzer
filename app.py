from flask import Flask, render_template, request, jsonify, Response, redirect, url_for, session
import json
from collections import Counter
import re
import os
from datetime import datetime

# Optional ML imports (lazy)
_TRANSFORMERS_AVAILABLE = False
try:
    from transformers import pipeline
    _TRANSFORMERS_AVAILABLE = True
except Exception:
    _TRANSFORMERS_AVAILABLE = False

# Persistence (SQLAlchemy)
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text
from sqlalchemy.orm import declarative_base, sessionmaker
import pandas as pd

app = Flask(__name__, template_folder="templates", static_folder="static")
# Secret key for sessions (use environment variable in production)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-key")

DB_URL = os.environ.get("QA_DB_URL", "sqlite:///qa.db")
engine = create_engine(DB_URL, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
Base = declarative_base()


# ------------------------------ Subject Topic Config ------------------------------
_TOPIC_CONFIG = {}
_TOPIC_REGEX_CACHE = {}
def _load_topic_config():
    global _TOPIC_CONFIG, _TOPIC_REGEX_CACHE
    if _TOPIC_CONFIG:
        return
    try:
        base = os.path.join(app.static_folder, 'data')
        path = os.path.join(base, 'topics.json')
        with open(path, 'r', encoding='utf-8') as f:
            _TOPIC_CONFIG = json.load(f)
    except Exception:
        _TOPIC_CONFIG = {}
    _TOPIC_REGEX_CACHE = {}

def _topic_for_subject(q: str, subject: str) -> str:
    _load_topic_config()
    low = (q or '').lower()
    conf = _TOPIC_CONFIG.get(subject) or {}
    # compile and cache regex
    if subject not in _TOPIC_REGEX_CACHE:
        import re as _re
        _TOPIC_REGEX_CACHE[subject] = { name: _re.compile(pattern) for name, pattern in conf.items() }
    for name, rgx in _TOPIC_REGEX_CACHE.get(subject, {}).items():
        try:
            if rgx.search(low):
                return name
        except Exception:
            continue
    return 'Other'

class AnalysisRecord(Base):
    __tablename__ = "analysis_records"
    id = Column(Integer, primary_key=True)
    text = Column(Text, nullable=False)
    difficulty = Column(String(16), nullable=False)
    bloom = Column(String(16), nullable=False)
    readability = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class GenerationRecord(Base):
    __tablename__ = "generation_records"
    id = Column(Integer, primary_key=True)
    paragraph = Column(Text, nullable=False)
    text = Column(Text, nullable=False)
    difficulty = Column(String(16), nullable=False)
    bloom = Column(String(16), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


Base.metadata.create_all(engine)


# -------------------- Heuristics (fallbacks if ML not available) --------------------

def classify_bloom_heuristic(text: str) -> str:
    low = text.lower()
    recall = [
        'define', 'list', 'name', 'recall', 'identify', 'state', 'what is', 'who is', 'when did'
    ]
    apply = [
        'apply', 'use', 'calculate', 'demonstrate', 'solve', 'show how', 'compute', 'implement'
    ]
    analyze = [
        'analyze', 'compare', 'contrast', 'differentiate', 'derive', 'prove', 'evaluate', 'assess', 'justify', 'why', 'how'
    ]
    if any(w in low for w in analyze):
        return 'Analyze'
    if any(w in low for w in apply):
        return 'Apply'
    if any(w in low for w in recall):
        return 'Recall'
    if len(low) > 120:
        return 'Apply'
    return 'Recall'


def predict_difficulty_heuristic(text: str) -> str:
    t = text.lower()
    score = 0
    if len(text) > 160:
        score += 2
    elif len(text) > 90:
        score += 1
    if re.search(r"prove|derive|theorem|optimize|analyze|complexity|integral|differential|regression", t):
        score += 2
    if re.search(r"calculate|apply|design|implement|constraint|approximate|justify", t):
        score += 1
    if re.search(r"list|define|name|identify|choose|select", t):
        score -= 1
    if score >= 3:
        return 'Hard'
    if score >= 1:
        return 'Medium'
    return 'Easy'


def _estimate_syllables(word: str) -> int:
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 0
    vowels = "aeiouy"
    count = 0
    prev_is_vowel = False
    for ch in w:
        is_vowel = ch in vowels
        if is_vowel and not prev_is_vowel:
            count += 1
        prev_is_vowel = is_vowel
    if w.endswith("e") and count > 1:
        count -= 1
    return max(1, count)


def readability_score(text: str) -> int:
    # Flesch Reading Ease score
    sentences = max(1, len([s for s in re.split(r"[.!?]+", text) if s.strip()]))
    words_list = [w for w in re.findall(r"[A-Za-z']+", text)]
    words = max(1, len(words_list))
    syllables = sum(_estimate_syllables(w) for w in words_list) or 1
    asl = words / sentences  # average sentence length
    asw = syllables / words  # average syllables per word
    score = 206.835 - 1.015 * asl - 84.6 * asw
    # Normalize to 0-100 for UI consistency
    score = max(0, min(100, round(score)))
    return score


def simple_sentence_split(paragraph: str):
    parts = re.split(r"(?<=[.!?])\s+", paragraph.strip())
    return [p.strip() for p in parts if p.strip()]


def make_question_from_sentence_heuristic(sent: str, preferred_bloom: str | None = None) -> str:
    topic = sent
    verbs = {
        'Recall': ['Define', 'List', 'Identify', 'State', 'Name', 'Describe'],
        'Apply': ['Apply', 'Use', 'Calculate', 'Demonstrate', 'Solve', 'Compute'],
        'Analyze': ['Analyze', 'Compare', 'Contrast', 'Evaluate', 'Justify', 'Assess', 'Derive']
    }
    if preferred_bloom and preferred_bloom in verbs:
        pool = verbs[preferred_bloom]
    else:
        pool = verbs['Recall'] + verbs['Apply'] + verbs['Analyze']
    verb = pool[len(sent) % len(pool)] if pool else 'Describe'
    topic_words = ' '.join(topic.split()[:8])
    return f"{verb} a concept related to {topic_words}."


# ------------------------------ Feedback Suggestions ------------------------------
def _feedback_heuristic(q: str, difficulty: str, bloom: str, readability: int) -> list[str]:
    suggestions: list[str] = []
    low = q.lower()
    # 1) Push towards analysis vs fact recall
    if bloom == 'Recall' or re.search(r"\b(define|list|name|what is|who|when)\b", low):
        suggestions.append(
            "Reframe the prompt to require reasoning or comparison. For example: 'Analyze', 'Compare', 'Evaluate', or 'Justify' instead of purely recalling facts."
        )
    # 2) Reduce ambiguity
    if re.search(r"\b(it|they|this|that|those|these)\b", low) and not re.search(r"\b(\w+)\s+(it|they|this|that|those|these)\b", low):
        suggestions.append(
            "Replace vague pronouns like 'it/they/this' with specific nouns to reduce ambiguity."
        )
    if len(q) > 180:
        suggestions.append("Split long sentences into shorter, clearer parts to avoid confusion.")
    # 3) Improve clarity/readability
    if readability < 50:
        suggestions.append("Simplify complex wording; aim for shorter sentences and common vocabulary.")
    if not q.strip().endswith('?') and len(q.split()) > 3:
        suggestions.append("End the prompt as a clear question and specify what is expected in the answer.")
    # 4) Align with outcomes / higher-order skills
    if bloom != 'Analyze':
        suggestions.append(
            "Align with higher-order outcomes: ask learners to interpret data, compare alternatives, justify choices, or critique assumptions."
        )
    if difficulty == 'Easy':
        suggestions.append("Increase challenge: add realistic constraints, multiple steps, or require explanation of reasoning.")
    return suggestions[:4] or ["Good question. Consider minor refinements for clarity and alignment with outcomes."]


_OPENAI_AVAILABLE = False
try:
    # Optional; only used if env USE_OPENAI_FEEDBACK=true
    import openai  # type: ignore
    _OPENAI_AVAILABLE = True
except Exception:
    _OPENAI_AVAILABLE = False


def generate_feedback_suggestions(q: str, difficulty: str, bloom: str, readability: int) -> list[str]:
    use_openai = os.environ.get("USE_OPENAI_FEEDBACK", "false").lower() in ("1", "true", "yes")
    api_key = os.environ.get("OPENAI_API_KEY")
    if use_openai and _OPENAI_AVAILABLE and api_key:
        try:
            openai.api_key = api_key
            prompt = (
                "Provide up to 4 concise suggestions to improve the following question for higher-order thinking, clarity, and alignment with learning outcomes.\n"
                f"Question: {q}\n"
                f"Current labels: Difficulty={difficulty}, Bloom={bloom}, Readability={readability}.\n"
                "Suggestions as a bullet list, no preface:"
            )
            resp = openai.ChatCompletion.create(
                model=os.environ.get("OPENAI_MODEL", "gpt-3.5-turbo"),
                messages=[{"role": "user", "content": prompt}],
                temperature=0.4,
                max_tokens=180,
            )
            text = resp["choices"][0]["message"]["content"].strip()
            # Split into lines and clean bullets
            lines = [re.sub(r"^[\-\*]\s*", "", ln).strip() for ln in text.splitlines() if ln.strip()]
            return lines[:4] or _feedback_heuristic(q, difficulty, bloom, readability)
        except Exception:
            # Fallback to heuristic
            pass
    return _feedback_heuristic(q, difficulty, bloom, readability)


# ------------------------------ Optional file OCR/Parsing ------------------------------
_PYPDF2_AVAILABLE = False
_PIL_AVAILABLE = False
_TESSERACT_AVAILABLE = False
_EASYOCR_AVAILABLE = False
try:
    import PyPDF2  # type: ignore
    _PYPDF2_AVAILABLE = True
except Exception:
    _PYPDF2_AVAILABLE = False
try:
    from PIL import Image  # type: ignore
    _PIL_AVAILABLE = True
except Exception:
    _PIL_AVAILABLE = False
try:
    import pytesseract  # type: ignore
    _TESSERACT_AVAILABLE = True
except Exception:
    _TESSERACT_AVAILABLE = False

try:
    import easyocr  # type: ignore
    _EASYOCR_AVAILABLE = True
except Exception:
    _EASYOCR_AVAILABLE = False

_easyocr_reader = None  # lazy cache


# ------------------------------ Optional ML Pipelines ------------------------------

_cls_pipeline = None
_qg_pipeline = None

def init_pipelines():
    global _cls_pipeline, _qg_pipeline
    if not _TRANSFORMERS_AVAILABLE:
        return
    analyzer_model = os.environ.get("ANALYZER_MODEL", "roberta-large-mnli")
    qg_model = os.environ.get("QG_MODEL", "mrm8488/t5-base-finetuned-question-generation-ap")
    try:
        # Zero-shot classification using RoBERTa MNLI (BERT/Roberta family)
        _cls_pipeline = pipeline("zero-shot-classification", model=analyzer_model)
    except Exception:
        _cls_pipeline = None
    try:
        # T5 model fine-tuned for Question Generation on SQuAD
        _qg_pipeline = pipeline("text2text-generation", model=qg_model)
    except Exception:
        _qg_pipeline = None


def classify_bloom_ml(text: str) -> str:
    if not _cls_pipeline:
        return classify_bloom_heuristic(text)
    labels = ["Recall", "Apply", "Analyze"]
    out = _cls_pipeline(text, candidate_labels=labels)
    return out.get("labels", ["Recall"])[0]


def predict_difficulty_ml(text: str) -> str:
    if not _cls_pipeline:
        return predict_difficulty_heuristic(text)
    labels = ["Easy", "Medium", "Hard"]
    out = _cls_pipeline(text, candidate_labels=labels)
    return out.get("labels", ["Easy"])[0]


def generate_question_ml(sentence: str) -> str:
    if not _qg_pipeline:
        return make_question_from_sentence_heuristic(sentence)
    # Many T5 QG checkpoints accept plain text; some expect prefixes like 'generate question:'
    prompt = f"generate question: {sentence}"
    out = _qg_pipeline(prompt, max_new_tokens=48, num_return_sequences=1)
    text = out[0]["generated_text"].strip()
    if not text.endswith("?"):
        text = text.rstrip('.') + "?"
    return text


# ----------------------------------- Routes -----------------------------------

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/home")
def home():
    return render_template("home.html")

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        # For now, accept any credentials and redirect to /home
        session["user"] = request.form.get("email", "user")
        return redirect(url_for("home"))
    return render_template("login.html")

@app.route("/dashboard")
def dashboard():
    # Redirect base dashboard to Analyze section
    return redirect(url_for("dashboard_analyze"))

@app.route("/dashboard/analyze")
def dashboard_analyze():
    return render_template("dashboard_analyze.html")

@app.route("/dashboard/generate")
def dashboard_generate():
    return render_template("dashboard_generate.html")

@app.route("/dashboard/compare")
def dashboard_compare():
    return render_template("dashboard_compare.html")

@app.route("/logout")
def logout():
    try:
        session.clear()
    except Exception:
        pass
    return redirect(url_for("login"))
# ------------------------------------ APIs ------------------------------------

def analyze_text_shared(q: str, use_ml: bool) -> dict:
    """Shared analyzer for a single question text."""
    if use_ml:
        difficulty = predict_difficulty_ml(q)
        bloom = classify_bloom_ml(q)
    else:
        difficulty = predict_difficulty_heuristic(q)
        bloom = classify_bloom_heuristic(q)
    feedback = generate_feedback_suggestions(q, difficulty, bloom, readability_score(q))
    return {
        "text": q,
        "difficulty": difficulty,
        "bloom": bloom,
        "readability": readability_score(q),
        "feedback": feedback,
    }


def _extract_questions_from_text(text: str) -> list[str]:
    lines = [ln.strip() for ln in re.split(r"\r?\n+", text) if ln.strip()]
    candidates: list[str] = []
    for ln in lines:
        if ln.endswith("?"):
            candidates.append(ln)
        elif len(ln) > 40:
            candidates.append(ln)
    return candidates


def _topic_bucket(q: str) -> str:
    low = q.lower()
    buckets = [
        ("algebra", r"algebra|equation|polynomial|matrix|vector"),
        ("geometry", r"geometry|triangle|circle|angle|area|perimeter|coordinate"),
        ("calculus", r"derivative|integral|limit|differential|gradient|series|calculus"),
        ("probability", r"probability|random|distribution|bayes|likelihood|event|odds"),
        ("statistics", r"mean|median|variance|regression|correlation|anova|statistic"),
        ("algorithms", r"algorithm|complexity|sort|search|graph|tree|dynamic programming|greedy"),
        ("programming", r"code|program|python|java|loop|function|class|object"),
        ("database", r"database|sql|query|table|schema|transaction|index|normalization"),
        ("networking", r"network|protocol|tcp|udp|ip|latency|throughput|packet"),
        ("physics", r"force|energy|velocity|acceleration|electric|magnetic|wave|optics"),
        ("chemistry", r"atom|molecule|reaction|bond|acid|base|organic|inorganic"),
        ("biology", r"cell|dna|genetic|enzyme|ecosystem|organism|physiology"),
    ]
    for name, pat in buckets:
        if re.search(pat, low):
            return name.title()
    return "Other"


def _similarity_counts(questions_by_paper: list[list[str]]) -> dict:
    # Flatten all questions with (paper_index, text)
    all_q = []
    for i, qs in enumerate(questions_by_paper):
        for q in qs:
            all_q.append((i, q))

    # Identical
    normalized = [re.sub(r"\s+", " ", q.strip().lower()) for _, q in all_q]
    seen = {}
    identical = 0
    for n in normalized:
        seen[n] = seen.get(n, 0) + 1
    for c in seen.values():
        if c > 1:
            identical += c - 1

    # Similar (TF-IDF cosine if available, else Jaccard)
    similar = 0
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer  # type: ignore
        from sklearn.metrics.pairwise import cosine_similarity  # type: ignore
        vec = TfidfVectorizer(stop_words='english')
        X = vec.fit_transform(normalized)
        sim = cosine_similarity(X)
        # Count cross-paper pairs above threshold
        threshold = 0.75
        n = len(all_q)
        for i in range(n):
            for j in range(i+1, n):
                if all_q[i][0] != all_q[j][0] and sim[i, j] >= threshold and normalized[i] != normalized[j]:
                    similar += 1
    except Exception:
        # Fallback Jaccard on tokens
        def jacc(a: str, b: str) -> float:
            sa = set(re.findall(r"[a-z0-9]+", a))
            sb = set(re.findall(r"[a-z0-9]+", b))
            if not sa or not sb:
                return 0.0
            return len(sa & sb) / max(1, len(sa | sb))
        n = len(all_q)
        for i in range(n):
            for j in range(i+1, n):
                if all_q[i][0] != all_q[j][0] and jacc(normalized[i], normalized[j]) >= 0.5 and normalized[i] != normalized[j]:
                    similar += 1
    return {"identical": int(identical), "similar": int(similar)}


@app.route("/api/compare_papers", methods=["POST"])
def api_compare_papers():
    files = request.files.getlist('files')
    subject = request.form.get('subject') or ''
    if not files or len(files) < 2:
        return jsonify({"error": "Upload at least two PDF files using form field 'files'."}), 400

    papers = []
    questions_by_paper: list[list[str]] = []
    paper_names: list[str] = []
    for f in files:
        name = (f.filename or "Paper").rsplit('/', 1)[-1]
        try:
            text = _extract_text_from_pdf(f.stream)
        except Exception as e:
            return jsonify({"error": f"Failed to read {name}: {e}"}), 400
        qs = _extract_questions_from_text(text)
        questions_by_paper.append(qs)
        paper_names.append(name)

        # Difficulty counts per paper
        diffs = {"Easy": 0, "Medium": 0, "Hard": 0}
        topics: dict[str, int] = {}
        for q in qs:
            d = predict_difficulty_heuristic(q)
            diffs[d] = diffs.get(d, 0) + 1
            # Subject-specific topic classification if configured
            if subject and subject in (_TOPIC_CONFIG or {}):
                t = _topic_for_subject(q, subject)
            else:
                t = _topic_bucket(q)
            topics[t] = topics.get(t, 0) + 1
        # compute top topics for this paper (top 5)
        _top_topics_list = sorted(topics.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        papers.append({
            "name": name,
            "count": len(qs),
            "difficulty": diffs,
            "topics": topics,
            "top_topics": [{"topic": k, "count": int(v)} for k, v in _top_topics_list],
        })

    # Overall verdict: which paper is harder (based on Hard weight 2, Medium 1, Easy 0)
    def hard_score(dmap: dict) -> float:
        return 2*dmap.get("Hard", 0) + 1*dmap.get("Medium", 0)
    hardest_idx = None
    best = -1
    for i, p in enumerate(papers):
        score = hard_score(p["difficulty"]) / max(1, p["count"])
        if score > best:
            best = score
            hardest_idx = i
    verdict = ""
    if hardest_idx is not None:
        names = [p["name"] for p in papers]
        verdict = f"{names[hardest_idx]} appears harder overall based on difficulty distribution."

    overlap = _similarity_counts(questions_by_paper)

    # Most repeated (identical) questions across papers
    norm_to_info: dict[str, dict] = {}
    for pi, qs in enumerate(questions_by_paper):
        for q in qs:
            norm = re.sub(r"\s+", " ", q.strip().lower())
            if norm not in norm_to_info:
                norm_to_info[norm] = {"text": q, "count": 0, "papers": set()}
            norm_to_info[norm]["count"] += 1
            norm_to_info[norm]["papers"].add(paper_names[pi])
    repeated = [
        {"text": v["text"], "count": v["count"], "papers": sorted(list(v["papers"]))}
        for v in norm_to_info.values() if v["count"] > 1
    ]
    repeated.sort(key=lambda x: (-x["count"], x["text"]))
    repeated = repeated[:10]

    # Overall important topics (top by frequency across all papers)
    all_topics: dict[str, int] = {}
    for p in papers:
        for k, v in p["topics"].items():
            all_topics[k] = all_topics.get(k, 0) + int(v)
    top_topics = sorted([{ "topic": k, "count": int(v) } for k, v in all_topics.items()], key=lambda x: (-x["count"], x["topic"]))[:10]

    # Build a short recommendation text
    rec_names = ", ".join([t["topic"] for t in top_topics[:5]]) if top_topics else ""
    if rec_names:
        if subject:
            recommendation_text = f"Key {subject} topics across papers: {rec_names}."
        else:
            recommendation_text = f"Key topics across papers: {rec_names}."
    else:
        recommendation_text = ""

    return jsonify({
        "papers": papers,
        "verdict": verdict,
        "overlap": overlap,
        "repeated_questions": repeated,
        "top_topics": top_topics,
        "subject": subject,
        "recommendation_text": recommendation_text,
    })

@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    data = request.get_json(silent=True) or {}
    question = data.get("question")
    questions = data.get("questions")

    use_ml = os.environ.get("USE_ML", "false").lower() in ("1", "true", "yes")
    if use_ml:
        init_pipelines()

    if question:
        result = analyze_text_shared(question, use_ml)
        return jsonify(result)
    elif questions and isinstance(questions, list):
        results = [analyze_text_shared(q, use_ml) for q in questions if isinstance(q, str) and q.strip()]
        diff_counts = Counter(r["difficulty"] for r in results)
        bloom_counts = Counter(r["bloom"] for r in results)
        return jsonify({
            "results": results,
            "summary": {
                "difficulty": diff_counts,
                "bloom": bloom_counts,
            }
        })
    else:
        return jsonify({"error": "Provide 'question' or 'questions' in JSON"}), 400


def _extract_text_from_pdf(file_storage) -> str:
    if not _PYPDF2_AVAILABLE:
        raise RuntimeError("PyPDF2 not installed; cannot parse PDFs. Add PyPDF2 to requirements and reinstall.")
    reader = PyPDF2.PdfReader(file_storage)
    texts = []
    for page in reader.pages:
        try:
            texts.append(page.extract_text() or "")
        except Exception:
            continue
    return "\n".join([t.strip() for t in texts if t and t.strip()])


def _extract_text_from_image(file_storage) -> str:
    """Extract text from an uploaded image using Tesseract or EasyOCR fallback.

    Priority:
    - If USE_EASYOCR=true or Tesseract not available, try EasyOCR.
    - Else use Tesseract (pytesseract).
    """
    global _easyocr_reader
    use_easy = os.environ.get("USE_EASYOCR", "false").lower() in ("1", "true", "yes")
    if not _PIL_AVAILABLE:
        raise RuntimeError("Pillow is required to read images. Install Pillow and retry.")

    # Always load via PIL to standardize input, then route to engine
    img = Image.open(file_storage).convert("RGB")

    # Check if Tesseract binary is actually available when not explicitly using EasyOCR
    if not use_easy and _TESSERACT_AVAILABLE:
        try:
            # This will raise if tesseract binary is not on PATH
            _ = pytesseract.get_tesseract_version()  # type: ignore
        except Exception:
            use_easy = True

    # Prefer EasyOCR if requested or if Tesseract is missing/not runnable
    if use_easy or not _TESSERACT_AVAILABLE:
        if not _EASYOCR_AVAILABLE:
            raise RuntimeError("EasyOCR not installed. Run 'pip install easyocr opencv-python-headless'.")
        if _easyocr_reader is None:
            langs = os.environ.get("EASYOCR_LANGS", "en").split(",")
            try:
                _easyocr_reader = easyocr.Reader(langs, gpu=False)  # type: ignore
            except Exception as e:
                raise RuntimeError(f"Failed to initialize EasyOCR: {e}")
        try:
            import numpy as np  # local import to avoid hard dep if unused
        except Exception:
            raise RuntimeError("NumPy missing. Install numpy to use EasyOCR.")
        arr = np.array(img)
        try:
            # detail=0 returns only strings; paragraph groups lines
            result = _easyocr_reader.readtext(arr, detail=0, paragraph=True)  # type: ignore
        except Exception as e:
            raise RuntimeError(f"EasyOCR failed: {e}")
        text = "\n".join([s.strip() for s in (result or []) if str(s).strip()])
        return text

    # Default: Tesseract path
    if not _TESSERACT_AVAILABLE:
        raise RuntimeError("pytesseract not installed. Either install Tesseract+pytesseract or set USE_EASYOCR=true and install EasyOCR.")
    tcmd = os.environ.get("TESSERACT_CMD")
    if tcmd:
        try:
            pytesseract.pytesseract.tesseract_cmd = tcmd  # type: ignore
        except Exception:
            pass
    # Try Tesseract; if it fails at runtime, fall back to EasyOCR if possible
    try:
        text = pytesseract.image_to_string(img)
        return text or ""
    except Exception as e:
        if _EASYOCR_AVAILABLE:
            # Fallback path
            try:
                import numpy as np
            except Exception:
                raise RuntimeError(f"Tesseract failed ({e}) and NumPy missing for EasyOCR fallback. Install numpy.")
            if _easyocr_reader is None:
                langs = os.environ.get("EASYOCR_LANGS", "en").split(",")
                try:
                    _easyocr_reader = easyocr.Reader(langs, gpu=False)  # type: ignore
                except Exception as ie:
                    raise RuntimeError(f"Tesseract failed ({e}) and EasyOCR init failed: {ie}")
            try:
                arr = np.array(img)
                result = _easyocr_reader.readtext(arr, detail=0, paragraph=True)  # type: ignore
                return "\n".join([s.strip() for s in (result or []) if str(s).strip()])
            except Exception as re2:
                raise RuntimeError(f"Both Tesseract and EasyOCR failed: {re2}")
        raise RuntimeError(f"Tesseract OCR failed: {e}")


@app.route("/api/analyze_file", methods=["POST"])
def api_analyze_file():
    """Accepts an uploaded PDF or image, extracts text, and analyzes questions.

    Returns a structure similar to /api/analyze with multiple results and summary.
    """
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No file provided. Use form field 'file'."}), 400

    filename = (f.filename or "").lower()
    try:
        if filename.endswith(".pdf"):
            text = _extract_text_from_pdf(f.stream)
        else:
            # Assume image
            text = _extract_text_from_image(f.stream)
    except Exception as e:
        return jsonify({"error": f"Failed to extract text: {e}"}), 400

    # Split extracted text into candidate questions (simple heuristic)
    # Split by newlines and ask-lines that end with '?' or are reasonably long statements.
    lines = [ln.strip() for ln in re.split(r"\r?\n+", text) if ln.strip()]
    candidates: list[str] = []
    for ln in lines:
        if ln.endswith("?"):
            candidates.append(ln)
        elif len(ln) > 40:  # likely a prompt sentence
            candidates.append(ln)

    if not candidates:
        return jsonify({"results": [], "summary": {"difficulty": {}, "bloom": {}}, "note": "No candidate questions detected in file."})

    use_ml = os.environ.get("USE_ML", "false").lower() in ("1", "true", "yes")
    if use_ml:
        init_pipelines()

    results = [analyze_text_shared(q, use_ml) for q in candidates]
    diff_counts = Counter(r["difficulty"] for r in results)
    bloom_counts = Counter(r["bloom"] for r in results)
    return jsonify({
        "results": results,
        "summary": {
            "difficulty": diff_counts,
            "bloom": bloom_counts,
        }
    })


@app.route("/api/generate", methods=["POST"])
def api_generate():
    data = request.get_json(silent=True) or {}
    paragraph = data.get("paragraph", "").strip()
    count = int(data.get("count", 5))
    preferred_difficulty = data.get("difficulty", "any")
    preferred_bloom = data.get("bloom", "any")

    if not paragraph:
        return jsonify({"error": "Provide 'paragraph' in JSON"}), 400

    use_ml = os.environ.get("USE_ML", "false").lower() in ("1", "true", "yes")
    if use_ml:
        init_pipelines()

    sentences = simple_sentence_split(paragraph) or [paragraph]
    questions = []
    for i in range(max(count, 1)):
        s = sentences[i % len(sentences)]
        if use_ml:
            q = generate_question_ml(s)
        else:
            qbloom = None if preferred_bloom == 'any' else preferred_bloom
            q = make_question_from_sentence_heuristic(s, qbloom)

        qdiff = predict_difficulty_ml(q) if (use_ml and preferred_difficulty == 'any') else (
            predict_difficulty_heuristic(q) if preferred_difficulty == 'any' else preferred_difficulty
        )
        qb = classify_bloom_ml(q) if (use_ml and preferred_bloom == 'any') else (
            classify_bloom_heuristic(q) if preferred_bloom == 'any' else preferred_bloom
        )
        questions.append({
            "text": q,
            "difficulty": qdiff,
            "bloom": qb,
        })

    diff_counts = Counter(q["difficulty"] for q in questions)
    bloom_counts = Counter(q["bloom"] for q in questions)

    return jsonify({
        "questions": questions,
        "summary": {
            "difficulty": diff_counts,
            "bloom": bloom_counts,
        }
    })


def _make_mcq_from_sentence(sent: str) -> dict:
    stem = make_question_from_sentence_heuristic(sent)
    # Very simple distractor creation by slicing words
    words = [w for w in re.findall(r"[A-Za-z]+", sent)][:4] or ["concept", "topic", "subject", "idea"]
    options = list({
        f"About {words[0] if words else 'concept'}",
        f"On {words[1] if len(words)>1 else 'topic'}",
        f"Regarding {words[2] if len(words)>2 else 'subject'}",
        f"Concerning {words[3] if len(words)>3 else 'idea'}",
    })
    correct_index = 0
    return {"question": stem.rstrip('.').rstrip('?') + '?', "options": options, "answer": options[correct_index]}


def _make_fill_blank_from_sentence(sent: str) -> dict:
    tokens = sent.split()
    if len(tokens) > 6:
        blank_index = len(tokens)//2
        answer = tokens[blank_index].strip(',.;:')
        tokens[blank_index] = '____'
        text = ' '.join(tokens)
    else:
        answer = tokens[-1].strip(',.;:') if tokens else '____'
        text = (sent + ' ____') if tokens else '____'
    return {"text": text, "answer": answer}


def _make_true_false_from_sentence(sent: str) -> dict:
    # Naive: flag as True, and make a negated variant for False elsewhere if needed
    statement = sent.rstrip('.').rstrip('?') + '.'
    return {"statement": statement, "answer": True}


def _make_short_answer_from_sentence(sent: str) -> dict:
    q = make_question_from_sentence_heuristic(sent)
    return {"question": q, "answer_hint": "One or two sentences."}


def _make_case_study_from_sentence(sent: str) -> dict:
    case_text = f"Case: {sent}"
    questions = [
        make_question_from_sentence_heuristic(sent, "Analyze"),
        make_question_from_sentence_heuristic(sent, "Apply"),
    ]
    return {"case": case_text, "questions": questions}


@app.route("/api/generate_formats", methods=["POST"])
def api_generate_formats():
    data = request.get_json(silent=True) or {}
    paragraph = data.get("paragraph", "").strip()
    count = int(data.get("count", 5))
    formats = data.get("formats")  # optional list of strings
    if not paragraph:
        return jsonify({"error": "Provide 'paragraph' in JSON"}), 400

    sentences = simple_sentence_split(paragraph) or [paragraph]

    all_out = {
        "MCQs": [],
        "FillInTheBlanks": [],
        "TrueFalse": [],
        "ShortAnswer": [],
        "CaseStudy": [],
    }
    selected = set([f for f in (formats or ["MCQs","FillInTheBlanks","TrueFalse","ShortAnswer","CaseStudy"]) if isinstance(f, str)])
    for i in range(max(1, count)):
        s = sentences[i % len(sentences)]
        if "MCQs" in selected:
            all_out["MCQs"].append(_make_mcq_from_sentence(s))
        if "FillInTheBlanks" in selected:
            all_out["FillInTheBlanks"].append(_make_fill_blank_from_sentence(s))
        if "TrueFalse" in selected:
            all_out["TrueFalse"].append(_make_true_false_from_sentence(s))
        if "ShortAnswer" in selected:
            all_out["ShortAnswer"].append(_make_short_answer_from_sentence(s))
        if "CaseStudy" in selected and i < 2:  # a couple case studies
            all_out["CaseStudy"].append(_make_case_study_from_sentence(s))

    # Only include selected keys in response
    resp = {k: v for k, v in all_out.items() if k in selected}
    return jsonify(resp)


# ----------------------------- Persistence APIs -----------------------------

@app.route("/api/save_analyzed", methods=["POST"])
def api_save_analyzed():
    data = request.get_json(silent=True) or {}
    items = data.get("items")  # list of {text,difficulty,bloom,readability}
    if not items or not isinstance(items, list):
        return jsonify({"error": "Provide 'items' as a list"}), 400
    db = SessionLocal()
    try:
        for it in items:
            rec = AnalysisRecord(
                text=str(it.get("text", ""))[:10000],
                difficulty=str(it.get("difficulty", "Unknown"))[:16],
                bloom=str(it.get("bloom", "Unknown"))[:16],
                readability=int(it.get("readability", 0)),
            )
            db.add(rec)
        db.commit()
        return jsonify({"status": "ok", "saved": len(items)})
    finally:
        db.close()


@app.route("/api/save_generated", methods=["POST"])
def api_save_generated():
    data = request.get_json(silent=True) or {}
    paragraph = data.get("paragraph", "")
    items = data.get("items")  # list of {text,difficulty,bloom}
    if not items or not isinstance(items, list):
        return jsonify({"error": "Provide 'items' as a list"}), 400
    db = SessionLocal()
    try:
        for it in items:
            rec = GenerationRecord(
                paragraph=str(paragraph)[:20000],
                text=str(it.get("text", ""))[:10000],
                difficulty=str(it.get("difficulty", "Unknown"))[:16],
                bloom=str(it.get("bloom", "Unknown"))[:16],
            )
            db.add(rec)
        db.commit()
        return jsonify({"status": "ok", "saved": len(items)})
    finally:
        db.close()


@app.route("/api/export", methods=["GET"])
def api_export():
    kind = request.args.get("type", "analyzed")
    db = SessionLocal()
    try:
        if kind == "generated":
            rows = db.query(GenerationRecord).all()
            data = [{
                "id": r.id,
                "paragraph": r.paragraph,
                "text": r.text,
                "difficulty": r.difficulty,
                "bloom": r.bloom,
                "created_at": r.created_at.isoformat(),
            } for r in rows]
        else:
            rows = db.query(AnalysisRecord).all()
            data = [{
                "id": r.id,
                "text": r.text,
                "difficulty": r.difficulty,
                "bloom": r.bloom,
                "readability": r.readability,
                "created_at": r.created_at.isoformat(),
            } for r in rows]
        df = pd.DataFrame(data)
        csv_bytes = df.to_csv(index=False).encode("utf-8")
        return Response(
            csv_bytes,
            headers={
                "Content-Disposition": f"attachment; filename={kind}_export.csv",
                "Content-Type": "text/csv; charset=utf-8",
            },
        )
    finally:
        db.close()


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
