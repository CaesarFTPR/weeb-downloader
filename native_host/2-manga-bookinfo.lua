--[[--
  KOReader User Patch: Manga Dedicated Book Information Card
  Version: 2.3.1
  Priority: 2 (Late - loaded after UIManager)

  Transforms KOReader's "Book Information" dialog for Manga/CBZ into a clean,
  dedicated Manga Card:
  1. Hides redundant technical filesystem rows and unwanted items:
     Filename, Format, Size, File date, Folder, Language, Rating, Review/Обзор,
     Notebook file/Файл заметок, Reader/Ридер, Series/Серии, Volume/Том.
  2. Elegant ordered Manga Passport:
     - 1. Название (Title)
     - 2. Описание (Synopsis)
     - 3. Associated name(s) (Альтернативные названия)
     - 4. Связанные серии (Related series)
     - followed by Author, Type, Status, Chapters, Year, Translation, Anime, 18+, Tags, Pages, Cover.
  3. Automatic Data Healing: Replaces all "Н/Д" / "N/A" / empty entries with actual metadata
     scraped from WeebCentral (stored in custom_metadata.lua, metadata.cbz.lua, or ComicInfo).
  4. Fixes row tap callbacks: tapping any item (including Related series) opens its own TextViewer
     instead of incorrectly opening the description!
  5. Displays everything on a single, elegant screen without multi-page pagination.
  6. Preserves 100% standard KOReader behavior for non-manga books (EPUB, PDF, FB2).
  7. Bulletproof pcall error isolation to guarantee KOReader never crashes or freezes.
--]]--

local ok_bi, BookInfo = pcall(require, "apps/filemanager/filemanagerbookinfo")
if not ok_bi or not BookInfo or BookInfo._manga_custom_patched == "2.3.1" then
    return
end
BookInfo._manga_custom_patched = "2.3.1"

local ok_bl, BookList = pcall(require, "ui/widget/booklist")
local ok_ds, DocSettings = pcall(require, "docsettings")

-- Custom manga properties and their user-friendly labels
local manga_props_defs = {
    { key = "associated_names",     label = "Associated name(s):" },
    { key = "related_series",       label = "Связанные серии:" },
    { key = "manga_type",           label = "Тип:" },
    { key = "status",               label = "Статус:" },
    { key = "total_chapters",       label = "Всего глав:" },
    { key = "chapters_count",       label = "Глав в томе:" },
    { key = "released",             label = "Год релиза:" },
    { key = "official_translation", label = "Офиц. перевод:" },
    { key = "anime_adaptation",     label = "Аниме:" },
    { key = "adult_content",        label = "18+ контент:" },
}

for item_idx, item in ipairs(manga_props_defs) do
    if not BookInfo.prop_text[item.key] then
        table.insert(BookInfo.props, item.key)
        BookInfo.prop_text[item.key] = item.label
    end
end

local function strip_icon(str)
    if not str then return "" end
    return tostring(str):gsub("^\u{F040}%s*", ""):gsub("^%s+", ""):gsub("%s+$", "")
end

local function is_empty(val)
    if val == nil then return true end
    local s = tostring(val):gsub("^%s*(.-)%s*$", "%1")
    return (s == "" or s == "nil" or s == "Н/Д" or s == "N/A" or s == "n/a")
end

local function clean_related(str)
    if not str then return str end
    return tostring(str):gsub("%(%((.-)%)%)", "(%1)")
end

-- Desired display priority for Manga Card in KOReader:
-- 1. Название, 2. Описание, 3. Associated name(s), 4. Связанные серии
local priority_map = {
    ["Название:"] = 1,
    ["Title:"] = 1,
    ["Описание:"] = 2,
    ["Description:"] = 2,
    ["Associated name(s):"] = 3,
    ["Associated names:"] = 3,
    ["Альтернативные названия:"] = 3,
    ["Другие названия:"] = 3,
    ["Связанные серии:"] = 4,
    ["Related series:"] = 4,
    ["Related Series(s):"] = 4,
    ["Автор(ы):"] = 5,
    ["Author(s):"] = 5,
    ["Тип:"] = 6,
    ["Type:"] = 6,
    ["Статус:"] = 7,
    ["Status:"] = 7,
    ["Всего глав:"] = 8,
    ["Total chapters:"] = 8,
    ["Глав в томе:"] = 9,
    ["Chapters count:"] = 9,
    ["Год релиза:"] = 10,
    ["Released:"] = 10,
    ["Офиц. перевод:"] = 11,
    ["Official translation:"] = 11,
    ["Аниме:"] = 12,
    ["Anime:"] = 12,
    ["18+ контент:"] = 13,
    ["Adult content:"] = 13,
    ["Тэги:"] = 14,
    ["Теги:"] = 14,
    ["Tags:"] = 14,
    ["Ключевые слова:"] = 14,
    ["Keywords:"] = 14,
    ["Страниц:"] = 15,
    ["Pages:"] = 15,
    ["Обложка:"] = 16,
    ["Cover image:"] = 16,
}

local label_to_prop = {
    ["Название:"] = "title",
    ["Title:"] = "title",
    ["Описание:"] = "description",
    ["Description:"] = "description",
    ["Associated name(s):"] = "associated_names",
    ["Associated names:"] = "associated_names",
    ["Альтернативные названия:"] = "associated_names",
    ["Другие названия:"] = "associated_names",
    ["Связанные серии:"] = "related_series",
    ["Related series:"] = "related_series",
    ["Related Series(s):"] = "related_series",
    ["Автор(ы):"] = "authors",
    ["Author(s):"] = "authors",
    ["Тип:"] = "manga_type",
    ["Type:"] = "manga_type",
    ["Статус:"] = "status",
    ["Status:"] = "status",
    ["Всего глав:"] = "total_chapters",
    ["Total chapters:"] = "total_chapters",
    ["Глав в томе:"] = "chapters_count",
    ["Chapters count:"] = "chapters_count",
    ["Год релиза:"] = "released",
    ["Released:"] = "released",
    ["Офиц. перевод:"] = "official_translation",
    ["Official translation:"] = "official_translation",
    ["Аниме:"] = "anime_adaptation",
    ["Anime:"] = "anime_adaptation",
    ["18+ контент:"] = "adult_content",
    ["Adult content:"] = "adult_content",
    ["Тэги:"] = "keywords",
    ["Теги:"] = "keywords",
    ["Tags:"] = "keywords",
    ["Ключевые слова:"] = "keywords",
    ["Keywords:"] = "keywords",
    ["Страниц:"] = "pages",
    ["Pages:"] = "pages",
}

-- Fields to eliminate from Book Information for Manga (removes technical clutter and unwanted rows)
local ignore_fields = {
    ["Имя файла:"] = true,
    ["Filename:"] = true,
    ["Формат:"] = true,
    ["Format:"] = true,
    ["Размер:"] = true,
    ["Size:"] = true,
    ["Дата файла:"] = true,
    ["File date:"] = true,
    ["Папка:"] = true,
    ["Folder:"] = true,
    ["Язык:"] = true,
    ["Language:"] = true,
    ["Рейтинг:"] = true,
    ["Rating:"] = true,
    ["Отзыв:"] = true,
    ["Обзор:"] = true,
    ["Review:"] = true,
    ["Файл блокнота:"] = true,
    ["Файл заметок:"] = true,
    ["Notebook file:"] = true,
    ["Current page:"] = true,
    ["Текущая страница:"] = true,
    ["Серии:"] = true,
    ["Серия:"] = true,
    ["Series:"] = true,
    ["Том:"] = true,
    ["Volume:"] = true,
    ["Индекс серий:"] = true,
    ["Series index:"] = true,
    ["Ридер:"] = true,
    ["Reader:"] = true,
    ["Device:"] = true,
    ["Источник:"] = true,
    ["Source:"] = true,
}

local function should_ignore(clean)
    if ignore_fields[clean] then return true end
    if clean:find("Обзор", 1, true) or clean:find("Отзыв", 1, true) or clean:find("Review", 1, true) then
        return true
    end
    if clean:find("Ридер", 1, true) or clean:find("Reader", 1, true) or clean:find("Device", 1, true) then
        return true
    end
    if clean:find("блокнот", 1, true) or clean:find("заметок", 1, true) or clean:find("Notebook", 1, true) then
        return true
    end
    if (clean:find("Сери", 1, true) or clean:find("Series", 1, true))
       and not clean:find("Связанн", 1, true) and not clean:find("Related", 1, true) then
        return true
    end
    if clean:find("Том", 1, true) or clean:find("Volume", 1, true) or clean:find("Индекс", 1, true) then
        return true
    end
    return false
end

local function show_text_viewer(title, text)
    local ok_uim, UIManager = pcall(require, "ui/uimanager")
    local ok_tv, TextViewer = pcall(require, "ui/widget/textviewer")
    if ok_uim and ok_tv and UIManager and TextViewer then
        UIManager:show(TextViewer:new{
            title = tostring(title or ""):gsub(":$", ""),
            text = tostring(text or ""),
            text_type = "book_info",
        })
    end
end

local function resolve_book_file(self, doc_settings_or_file)
    if type(doc_settings_or_file) == "string" then
        return doc_settings_or_file
    end
    if type(doc_settings_or_file) == "table" and doc_settings_or_file.readSetting then
        local p = doc_settings_or_file:readSetting("doc_path")
        if p and p ~= "" then return p end
    end
    if self.document and self.document.file then
        return self.document.file
    end
    if self.ui and self.ui.doc_settings and self.ui.doc_settings.readSetting then
        local p = self.ui.doc_settings:readSetting("doc_path")
        if p and p ~= "" then return p end
    end
    return nil
end

local function load_real_props(file)
    local props = {}
    if not file or type(file) ~= "string" then return props end

    local sdr = file:gsub("%.%w+$", ".sdr")
    local candidates = {
        sdr .. "/custom_metadata.lua",
        sdr .. "/metadata.cbz.lua",
        sdr .. "/metadata.zip.lua",
    }

    for _, path in ipairs(candidates) do
        local ok, data = pcall(dofile, path)
        if ok and type(data) == "table" then
            local cp = data.custom_props or data.doc_props or data
            if type(cp) == "table" then
                for k, v in pairs(cp) do
                    if (props[k] == nil or is_empty(props[k])) and not is_empty(v) then
                        props[k] = v
                    end
                end
            end
        end
    end
    return props
end

-- Wrap BookInfo:show to cleanly transform the manga view and keep regular books standard
local orig_show = BookInfo.show
BookInfo.show = function(self, doc_settings_or_file, book_props)
    local file = resolve_book_file(self, doc_settings_or_file)
    local real_props = load_real_props(file)

    local is_manga = false
    if file and type(file) == "string" and (file:lower():match("%.cbz$") or file:lower():match("%.cbr$") or file:lower():match("%.zip$")) then
        is_manga = true
    elseif type(doc_settings_or_file) == "table" and doc_settings_or_file.readSetting and doc_settings_or_file:readSetting("inverse_reading_order") == true then
        is_manga = true
    elseif book_props and (book_props.manga_type or book_props.total_chapters or book_props.status or book_props.associated_names) then
        is_manga = true
    elseif real_props and (real_props.manga_type or real_props.total_chapters or real_props.status or real_props.associated_names) then
        is_manga = true
    end

    -- Hydrate book_props with real_props to prevent KOReader's "Н/Д"
    book_props = book_props or {}
    for k, v in pairs(real_props) do
        if is_empty(book_props[k]) and not is_empty(v) then
            book_props[k] = v
        end
    end

    -- Extract passport fields from description text if missing in book_props
    local desc_text = (book_props and book_props.description) or real_props.description
    if is_manga and desc_text and type(desc_text) == "string" then
        if is_empty(book_props.associated_names) then
            book_props.associated_names = desc_text:match("• Associated Name%(s%):%s*([^\n]+)")
                or desc_text:match("• Альтернативные названия:%s*([^\n]+)")
                or desc_text:match("• Другие названия:%s*([^\n]+)")
        end
        if is_empty(book_props.related_series) then book_props.related_series = desc_text:match("• Связанные серии:%s*([^\n]+)") end
        if is_empty(book_props.status) then book_props.status = desc_text:match("• Статус:%s*([^\n]+)") end
        if is_empty(book_props.manga_type) then book_props.manga_type = desc_text:match("• Тип:%s*([^\n]+)") end
        if is_empty(book_props.released) then book_props.released = desc_text:match("• Год релиза:%s*([^\n]+)") end
        if is_empty(book_props.official_translation) then book_props.official_translation = desc_text:match("• Официальный перевод:%s*([^\n]+)") end
        if is_empty(book_props.anime_adaptation) then book_props.anime_adaptation = desc_text:match("• Аниме%-адаптация:%s*([^\n]+)") end
        if is_empty(book_props.adult_content) then book_props.adult_content = desc_text:match("• 18%+ Контент:%s*([^\n]+)") end
        if is_empty(book_props.total_chapters) then book_props.total_chapters = desc_text:match("• Всего глав:%s*(%d+)") or desc_text:match("из (%d+) на сайте") end
        if is_empty(book_props.chapters_count) then book_props.chapters_count = desc_text:match("• Глав в томе:%s*(%d+)") end
    end

    -- Keep real_props in sync with any parsed values
    if book_props and book_props.related_series then
        book_props.related_series = clean_related(book_props.related_series)
    end
    if real_props and real_props.related_series then
        real_props.related_series = clean_related(real_props.related_series)
    end
    for k, v in pairs(book_props) do
        if not is_empty(v) and is_empty(real_props[k]) then
            real_props[k] = v
        end
    end

    local ok_kvp, KeyValuePage = pcall(require, "ui/widget/keyvaluepage")
    if not ok_kvp or not KeyValuePage then
        return orig_show(self, doc_settings_or_file, book_props)
    end

    local orig_kvp_new = KeyValuePage.new
    KeyValuePage.new = function(kvp_class, options)
        KeyValuePage.new = orig_kvp_new
        if not options or not options.kv_pairs then
            return orig_kvp_new(kvp_class, options)
        end

        local ok_transform, transform_err = pcall(function()
            if not is_manga then
                -- Non-manga documents (EPUB/PDF): only remove empty custom manga properties
                local filtered = {}
                for pair_idx, pair in ipairs(options.kv_pairs) do
                    local clean = strip_icon(pair[1] or "")
                    local is_custom = false
                    for def_idx, def in ipairs(manga_props_defs) do
                        if clean:find(def.label, 1, true) then
                            is_custom = true
                            break
                        end
                    end
                    if not is_custom or not is_empty(pair[2]) then
                        table.insert(filtered, pair)
                    end
                end
                options.kv_pairs = filtered
                return
            end

            -- Dedicated Manga Card transformation
            local kept = {}
            local seen_props = {}
            local cover_pair = nil

            for pair_idx, pair in ipairs(options.kv_pairs) do
                local label = pair[1] or ""
                local clean = strip_icon(label)
                local val = pair[2]

                if clean:find("Обложка", 1, true) or clean:find("Cover", 1, true) then
                    cover_pair = pair
                elseif not should_ignore(clean) then
                    -- Heal "Н/Д" or empty values with actual metadata from real_props
                    if is_empty(val) then
                        local pkey = label_to_prop[clean]
                        if pkey and not is_empty(real_props[pkey]) then
                            val = tostring(real_props[pkey])
                            pair[2] = val
                        end
                    end

                    if not is_empty(val) then
                        if clean:find("Ключевые слова", 1, true) or clean:find("Keywords", 1, true) then
                            clean = "Тэги:"
                            pair[1] = "Тэги:"
                        end
                        if clean:find("Связанные серии", 1, true) or clean:find("Related", 1, true) then
                            val = clean_related(val)
                            pair[2] = val
                        end
                        table.insert(kept, pair)
                        local pkey = label_to_prop[clean]
                        if pkey then seen_props[pkey] = true end
                    end
                end
            end

            -- Inject any missing manga fields directly from real_props
            local default_prop_labels = {
                { key = "title",                label = "Название:" },
                { key = "description",          label = "Описание:" },
                { key = "associated_names",     label = "Associated name(s):" },
                { key = "related_series",       label = "Связанные серии:" },
                { key = "authors",              label = "Автор(ы):" },
                { key = "manga_type",           label = "Тип:" },
                { key = "status",               label = "Статус:" },
                { key = "total_chapters",       label = "Всего глав:" },
                { key = "chapters_count",       label = "Глав в томе:" },
                { key = "released",             label = "Год релиза:" },
                { key = "official_translation", label = "Офиц. перевод:" },
                { key = "anime_adaptation",     label = "Аниме:" },
                { key = "adult_content",        label = "18+ контент:" },
                { key = "keywords",             label = "Тэги:" },
                { key = "pages",                label = "Страниц:" },
            }

            for _, item in ipairs(default_prop_labels) do
                if not seen_props[item.key] and not is_empty(real_props[item.key]) then
                    table.insert(kept, { item.label, tostring(real_props[item.key]) })
                    seen_props[item.key] = true
                end
            end

            -- Ensure Manga type is present
            if not seen_props["manga_type"] then
                local def_val = real_props.manga_type or (book_props and book_props.manga_type) or "Manga"
                table.insert(kept, { "Тип:", def_val })
            end

            -- Add cover pair if present
            if cover_pair then
                table.insert(kept, cover_pair)
            end

            -- Sort by Manga priority map (Title #1, Description #2, Associated names #3, Related series #4)
            table.sort(kept, function(a, b)
                local pa = priority_map[strip_icon(a[1] or "")] or 90
                local pb = priority_map[strip_icon(b[1] or "")] or 90
                return pa < pb
            end)

            -- Rebind row tap callbacks so each item opens its own TextViewer
            -- (Fixes KOReader bug where custom items inherited Description's callback)
            for p_idx, p in ipairs(kept) do
                local label_clean = strip_icon(p[1] or "")
                local val = p[2]
                if label_clean:find("Обложка", 1, true) or label_clean:find("Cover", 1, true) then
                    -- Preserve original full-screen cover viewer
                else
                    local cur_lbl = label_clean
                    local cur_val = val
                    p.callback = function()
                        show_text_viewer(cur_lbl, cur_val)
                    end
                end
            end

            -- Visual section separators:
            -- KOReader draws a horizontal divider underneath any row where `p.separator = true`.
            -- Logical groupings:
            -- 1) Header & Overview: Название, Описание, Associated names, Связанные серии [divider]
            -- 2) Publication & Chapters: Автор, Тип, Статус, Главы, Релиз, Перевод, Аниме, 18+ [divider]
            -- 3) Metadata: Тэги, Страниц [divider]
            -- 4) Cover Preview [divider]
            for p_idx, p in ipairs(kept) do
                p.separator = false
                local c = strip_icon(p[1] or "")
                if c:find("Связанные серии", 1, true) or c:find("Related", 1, true)
                   or c:find("18+", 1, true) or c:find("Adult", 1, true)
                   or c:find("Страниц", 1, true) or c:find("Pages", 1, true)
                   or c:find("Обложка", 1, true) or c:find("Cover", 1, true) then
                    p.separator = true
                end
            end

            options.kv_pairs = kept

            -- When items fit within a single screen, disable pagination footer
            if #kept <= 18 then
                options.single_page = true
            end
        end)

        if not ok_transform then
            -- Fall back silently to original unpatched options, guaranteeing KOReader never hangs
            io.stderr:write("[manga-bookinfo] transform error: " .. tostring(transform_err) .. "\n")
        end

        return orig_kvp_new(kvp_class, options)
    end

    return orig_show(self, doc_settings_or_file, book_props)
end
