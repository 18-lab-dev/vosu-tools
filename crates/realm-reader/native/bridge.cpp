#include <realm/group.hpp>
#include <realm/table.hpp>
#include <realm/obj.hpp>
#include <realm/list.hpp>
#include <realm/db.hpp>
#include <realm/transaction.hpp>
#include <thread>
#include <chrono>
#include <ostream>
#include <streambuf>
#include <cstring>
#include <exception>

namespace {
class RowBuffer : public std::streambuf {
public:
    std::string text;
private:
    bool in_string = false;
    bool escaped = false;
protected:
    std::streamsize xsputn(const char* data, std::streamsize count) override {
        // Core's diagnostic JSON does not escape every U+0000..U+001F.
        // Preserve those database strings losslessly as legal JSON escapes.
        static const char hex[] = "0123456789abcdef";
        for (std::streamsize i = 0; i < count; ++i) {
            unsigned char c = static_cast<unsigned char>(data[i]);
            bool control = in_string && c < 0x20;
            if (text.size() + (control ? 6 : 1) > 4 * 1024 * 1024) return i;
            if (control) {
                text += "\\u00";
                text += hex[c >> 4];
                text += hex[c & 15];
            } else {
                text += static_cast<char>(c);
            }
            if (escaped) escaped = false;
            else if (in_string && c == '\\') escaped = true;
            else if (c == '"') in_string = !in_string;
        }
        return count;
    }
    int_type overflow(int_type ch) override {
        if (traits_type::eq_int_type(ch, traits_type::eof())) return traits_type::not_eof(ch);
        char c = traits_type::to_char_type(ch);
        return xsputn(&c, 1) == 1 ? ch : traits_type::eof();
    }
};
}
// No DB/SharedRealm is constructed: Group opens an immutable private snapshot,
// never the source and never any .lock or .management sidecars.
extern "C" int vosu_realm_scan(const char* path, int (*row)(void*, const char*, const char*, size_t), void* ctx, char* error, size_t cap) noexcept {
    try {
        realm::Group group(path);
        const char* names[] = {"metadata", "class_BeatmapSet", "class_Beatmap", "class_Skin", "class_Score", "class_Ruleset", "class_BeatmapMetadata"};
        for (auto name : names) {
            auto table = group.get_table(name);
            if (!table) continue;
            for (auto obj : *table) {
                RowBuffer buffer;
                std::ostream out(&buffer);
                obj.to_json(out);
                const auto& text = buffer.text;
                if (!out || row(ctx, name, text.data(), text.size()) != 0)
                    throw std::runtime_error("Realm index exceeds configured memory/row limit");
            }
        }
        return 0;
    } catch (const std::exception& e) {
        if (cap) { std::strncpy(error, e.what(), cap - 1); error[cap - 1] = 0; }
        return -1;
    } catch (...) {
        if (cap) { std::strncpy(error, "unknown Realm exception", cap - 1); error[cap - 1] = 0; }
        return -1;
    }
}

// Reproducible, deliberately tiny fixture. Only callable through Rust's test API.
extern "C" int vosu_realm_fixture(const char* path, int generation) noexcept {
    try {
        realm::Group g;
        auto meta = g.add_table("metadata");
        auto version = meta->add_column(realm::type_Int, "version");
        meta->create_object().set(version, int64_t(52));
        auto rules = g.add_table_with_primary_key("class_Ruleset", realm::type_String, "ShortName");
        auto rule = rules->create_object_with_primary_key("mania");
        auto files = g.add_table_with_primary_key("class_File", realm::type_String, "Hash");
        auto file = files->create_object_with_primary_key("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        auto audio = files->create_object_with_primary_key("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        auto background = files->create_object_with_primary_key("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
        auto users = g.add_table("class_RealmUser", realm::Table::Type::Embedded);
        auto username = users->add_column(realm::type_String, "Username");
        auto metadata = g.add_table("class_BeatmapMetadata");
        auto artist = metadata->add_column(realm::type_String, "Artist");
        auto title = metadata->add_column(realm::type_String, "Title");
        auto author = metadata->add_column(*users, "Author");
        auto audio_name = metadata->add_column(realm::type_String, "AudioFile");
        auto background_name = metadata->add_column(realm::type_String, "BackgroundFile");
        auto map_metadata = metadata->create_object().set(artist, "Fixture artist").set(title, "Fixture title").set(audio_name, "AUDIO.mp3").set(background_name, "background.jpg");
        map_metadata.create_and_set_linked_object(author).set(username, "Fixture creator");
        auto usage = g.add_table("class_RealmNamedFileUsage", realm::Table::Type::Embedded);
        auto filename = usage->add_column(realm::type_String, "Filename");
        auto filelink = usage->add_column(*files, "File");
        auto sets = g.add_table_with_primary_key("class_BeatmapSet", realm::type_Int, "ID");
        auto online = sets->add_column(realm::type_Int, "OnlineID");
        auto setfiles = sets->add_column_list(*usage, "Files");
        auto set = sets->create_object_with_primary_key(int64_t(1)).set(online, int64_t(123));
        set.get_linklist(setfiles).create_and_insert_linked_object(0).set(filename, "fixture.osu").set(filelink, file.get_key());
        set.get_linklist(setfiles).create_and_insert_linked_object(1).set(filename, "audio.mp3").set(filelink, audio.get_key());
        set.get_linklist(setfiles).create_and_insert_linked_object(2).set(filename, "background.jpg").set(filelink, background.get_key());
        auto maps = g.add_table_with_primary_key("class_Beatmap", realm::type_Int, "ID");
        auto md5 = maps->add_column(realm::type_String, "MD5Hash");
        auto hash = maps->add_column(realm::type_String, "Hash");
        auto difficulty = maps->add_column(realm::type_String, "DifficultyName");
        auto pathcol = maps->add_column(realm::type_String, "Path");
        auto setlink = maps->add_column(*sets, "BeatmapSet");
        auto rulelink = maps->add_column(*rules, "Ruleset");
        auto metadata_link = maps->add_column(*metadata, "Metadata");
        maps->create_object_with_primary_key(int64_t(1)).set(md5, "0123456789abcdef0123456789abcdef").set(hash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").set(pathcol, "fixture.osu").set(difficulty, generation ? "Generation B" : "Generation A").set(setlink, set.get_key()).set(rulelink, rule.get_key()).set(metadata_link, map_metadata.get_key());
        auto skins = g.add_table_with_primary_key("class_Skin", realm::type_String, "ID");
        auto skinname = skins->add_column(realm::type_String, "Name");
        auto skinfiles = skins->add_column_list(*usage, "Files");
        auto skin = skins->create_object_with_primary_key("fixture-skin").set(skinname, "Fixture\x01skin");
        skin.get_linklist(skinfiles).create_and_insert_linked_object(0).set(filename, "Skin.INI").set(filelink, file.get_key());
        auto scores = g.add_table_with_primary_key("class_Score", realm::type_String, "ID");
        auto scorehash = scores->add_column(realm::type_String, "BeatmapHash");
        auto total = scores->add_column(realm::type_Int, "TotalScore");
        auto score_date = scores->add_column(realm::type_Timestamp, "Date");
        auto score_user = scores->add_column(*users, "User");
        auto score_mods = scores->add_column(realm::type_String, "Mods");
        auto score = scores->create_object_with_primary_key("fixture-score").set(scorehash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").set(total, int64_t(generation ? 200 : 100)).set(score_date, realm::Timestamp(1700000000, 123456000)).set(score_mods, "[{\"acronym\":\"DT\"}]");
        score.create_and_set_linked_object(score_user).set(username, "Fixture player");
        g.write(path);
        return 0;
    } catch (...) { return -1; }
}

// Test-only writer: opens only caller-generated fixture paths, never product data.
extern "C" int vosu_realm_test_commits(const char* path, int count) noexcept {
    try {
        auto db = realm::DB::create(path);
        for (int i = 0; i < count; ++i) {
            auto tx = db->start_write();
            auto maps = tx->get_table("class_Beatmap");
            auto scores = tx->get_table("class_Score");
            auto difficulty = maps->get_column_key("DifficultyName");
            auto total = scores->get_column_key("TotalScore");
            auto map = *maps->begin();
            auto score = *scores->begin();
            map.set(difficulty, i % 2 ? "Generation B" : "Generation A");
            score.set(total, int64_t(i % 2 ? 200 : 100));
            tx->commit();
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        return 0;
    } catch (...) { return -1; }
}
