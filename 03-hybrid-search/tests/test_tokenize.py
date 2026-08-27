from hybrid_search.tokenize import stem, tokenize


def test_lowercases_and_splits():
    assert tokenize("Kill THE Process") == ["kill", "process"]


def test_drops_stopwords():
    assert tokenize("the and of is") == []


def test_morphological_variants_share_a_stem():
    assert stem("cache") == stem("caching") == stem("cached")
    assert stem("delete") == stem("deleted") == stem("deleting")
    assert stem("stores") == stem("stored") == stem("store")


def test_undoubles_after_suffix_strip():
    assert stem("stopped") == "stop"
    assert stem("running") == "run"


def test_does_not_undouble_ll_ss_zz():
    # the doubled letter belongs to the base word, not to the stripped
    # suffix, so undoubling it splits a word from its own inflections
    assert stem("kill") == stem("killed") == stem("killing")
    assert stem("install") == stem("installed") == stem("installs")
    assert stem("call") == stem("calling") == stem("calls")
    assert stem("pass") == stem("passed") == stem("passing")
    assert stem("fizz") == stem("fizzed") == stem("fizzing")


def test_inflected_document_term_matches_base_query_term():
    assert "kill" in tokenize("the process was killed")
    assert "install" in tokenize("dependencies are installed here")


def test_plural_stripping():
    assert stem("queries") == "query"
    assert stem("processes") == stem("process")
    assert stem("class") == "class"


def test_short_words_untouched():
    assert stem("ssh") == "ssh"
    assert stem("git") == "git"


def test_hyphen_compound_kept_whole_and_split():
    tokens = tokenize("use --force-with-lease here")
    # the whole compound survives (stemmed like everything else) plus parts
    whole = [t for t in tokens if "-" in t]
    assert len(whole) == 1
    assert whole[0] in tokenize("git push --force-with-lease")
    assert "forc" in tokens or "force" in tokens
    assert "leas" in tokens or "lease" in tokens


def test_hyphen_parts_match_plain_words():
    compound = tokenize("logged-in user")
    plain = tokenize("logged in as user")
    assert set(compound) & set(plain)


def test_empty_input():
    assert tokenize("") == []
    assert tokenize("   \n\t ") == []


def test_numbers_survive():
    assert "502" in tokenize("a 502 error")
    assert "8080" in tokenize("port 8080")


def test_non_ascii_does_not_crash():
    assert tokenize("キャッシュ") == []
    assert "caf" in tokenize("café")


def test_punctuation_only():
    assert tokenize("!!! ??? ...") == []
