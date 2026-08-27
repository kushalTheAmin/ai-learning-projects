from chunking.sentences import split_sentences


def test_simple_two_sentences():
    text = "The cat sat. The dog barked."
    sentences = split_sentences(text)
    assert [s.text for s in sentences] == ["The cat sat.", "The dog barked."]


def test_spans_map_back_to_source():
    text = "First one here. Second one there! Third, a question? Yes."
    for s in split_sentences(text):
        assert text[s.start : s.end] == s.text


def test_spans_are_ordered_and_disjoint():
    text = "Alpha runs nightly. Beta runs weekly. Gamma never runs."
    sentences = split_sentences(text)
    for a, b in zip(sentences, sentences[1:]):
        assert a.end <= b.start
        assert text[a.end : b.start].strip() == ""


def test_abbreviations_do_not_split():
    text = "Check the caches, e.g. Redis and Memcached, before failing over. Then restart."
    sentences = split_sentences(text)
    assert len(sentences) == 2
    assert sentences[0].text.startswith("Check the caches")


def test_ie_etc_vs_approx_do_not_split():
    # the following word is capitalized in each case, so only the
    # abbreviation guard keeps these whole
    for text in (
        "Probes check dependencies, i.e. The database matters here.",
        "Limits and timeouts, etc. Are tuned per service.",
        "Latency vs. Throughput is the real trade.",
        "It takes approx. Five minutes to converge.",
    ):
        assert len(split_sentences(text)) == 1


def test_decimals_do_not_split():
    text = "The alert fires at 14.4 times the rate. Latency peaked at 2.4 seconds."
    sentences = split_sentences(text)
    assert len(sentences) == 2
    assert "14.4" in sentences[0].text
    assert "2.4" in sentences[1].text


def test_dotted_names_do_not_split():
    text = "Logs ship to the topic logs.raw with 12 partitions. Retention is 72 hours."
    assert len(split_sentences(text)) == 2


def test_no_trailing_terminator():
    text = "First sentence ends. the tail has no terminator and no capital"
    sentences = split_sentences(text)
    assert len(sentences) == 1
    text2 = "First sentence ends. The tail has no terminator"
    sentences2 = split_sentences(text2)
    assert len(sentences2) == 2
    assert sentences2[1].text == "The tail has no terminator"


def test_lowercase_continuation_does_not_split():
    text = "The service listens on port 8080. it restarts on failure."
    assert len(split_sentences(text)) == 1


def test_empty_and_whitespace():
    assert split_sentences("") == []
    assert split_sentences("   \n\t  ") == []


def test_single_sentence():
    sentences = split_sentences("Just one sentence here.")
    assert len(sentences) == 1
    assert sentences[0].start == 0


def test_multiple_terminators():
    text = "Really?! Yes. Truly!!! Fine."
    assert [s.text for s in split_sentences(text)] == [
        "Really?!",
        "Yes.",
        "Truly!!!",
        "Fine.",
    ]


def test_closing_quote_stays_with_sentence():
    text = "He said 'stop.' Then he left."
    sentences = split_sentences(text)
    assert len(sentences) == 2
    assert sentences[0].text == "He said 'stop.'"


def test_unicode_text():
    text = "Café latency rose to naïve levels. Ößterreich responded quickly."
    sentences = split_sentences(text)
    assert len(sentences) == 2
    for s in sentences:
        assert text[s.start : s.end] == s.text


def test_sentence_starting_with_digit():
    text = "The window is short. 30 seconds is the default."
    assert len(split_sentences(text)) == 2
