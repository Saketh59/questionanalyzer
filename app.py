from flask import Flask, render_template, request, jsonify, Response
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

DB_URL = os.environ.get("QA_DB_URL", "sqlite:///qa.db")
engine = create_engine(DB_URL, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
Base = declarative_base()


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


@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html")


# ------------------------------------ APIs ------------------------------------

@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    data = request.get_json(silent=True) or {}
    question = data.get("question")
    questions = data.get("questions")

    use_ml = os.environ.get("USE_ML", "false").lower() in ("1", "true", "yes")
    if use_ml:
        init_pipelines()

    def analyze_text(q: str):
        if use_ml:
            difficulty = predict_difficulty_ml(q)
            bloom = classify_bloom_ml(q)
        else:
            difficulty = predict_difficulty_heuristic(q)
            bloom = classify_bloom_heuristic(q)
        return {
            "text": q,
            "difficulty": difficulty,
            "bloom": bloom,
            "readability": readability_score(q),
        }

    if question:
        result = analyze_text(question)
        return jsonify(result)
    elif questions and isinstance(questions, list):
        results = [analyze_text(q) for q in questions if isinstance(q, str) and q.strip()]
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
