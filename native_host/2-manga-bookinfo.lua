--[[--
  KOReader User Patch: Manga Dedicated Book Information Card
  Version: 2.2.0
  Priority: 2 (Late - loaded after UIManager)

  Transforms KOReader's "Book Information" dialog for Manga/CBZ into a clean,
  dedicated Manga Card:
  1. Hides redundant technical filesystem rows and unwanted items:
     Filename, Format, Size, File date, Folder, Language, Rating, Review/Обзор,
     Notebook file/Файл заметок, Reader/Ридер, Series/Серии.
  2. Places Description, Associated name(s), and Related series at the very top:
     - 1. Описание (Synopsis)
     - 2. Associated name(s) (Альтернативные названия)
     - 3. Связанные серии (Related series)
     - followed by Title, Author, Type, Status, Chapters, Year, Translation, Anime, 18+, Genres, Volume, Pages, Cover.
  3. Fixes row tap callbacks: tapping any item (including Related series) opens its own TextViewer
     instead of incorrectly opening the description!
  4. Displays everything on a single, elegant screen without multi-page pagination.
  5. Preserves 100% standard KOReader behavior for non-manga books (EPUB, PDF, FB2).
  6. Bulletproof pcall error isolation to guarantee KOReader never crashes or freezes.
--]]--

local ok_bi, BookInfo = pcall(require, "apps/filemanager/filemanagerbookinfo")
if not ok_bi or not BookInfo or BookInfo._manga_custom_patched == "2.2.0" then
    return
end
BookInfo._manga_custom_patched = "2.2.0"

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

-- Desired display priority for Manga Card in KOReader:
-- 1. Description, 2. Associated name(s), 3. Related series at the very top
local priority_map = {
    ["Описание:"] = 1,
    ["Description:"] = 1,
    ["Associated name(s):"] = 2,
    ["Associated names:"] = 2,
    ["Альтернативные названия:"] = 2,
    ["Связанные серии:"] = 3,
    ["Related series:"] = 3,
    ["Related Series(s):"] = 3,
    ["Название:"] = 4,
    ["Title:"] = 4,
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
    ["Том:"] = 10,
    ["Год релиза:"] = 11,
    ["Released:"] = 11,
    ["Офиц. перевод:"] = 12,
    ["Official translation:"] = 12,
    ["Аниме:"] = 13,
    ["Anime:"] = 13,
    ["18+ контент:"] = 14,
    ["Adult content:"] = 14,
    ["Ключевые слова:"] = 15,
    ["Keywords:"] = 15,
    ["Страниц:"] = 16,
    ["Pages:"] = 16,
    ["Обложка:"] = 17,
    ["Cover image:"] = 17,
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

-- Wrap BookInfo:show to cleanly transform the manga view and keep regular books standard
local orig_show = BookInfo.show
BookInfo.show = function(self, doc_settings_or_file, book_props)
    local has_sidecar = type(doc_settings_or_file) == "table"
    local file = has_sidecar and doc_settings_or_file.readSetting and doc_settings_or_file:readSetting("doc_path") or doc_settings_or_file
    if not has_sidecar and self.document and self.document.file == file then
        doc_settings_or_file = self.ui and self.ui.doc_settings
        has_sidecar = type(doc_settings_or_file) == "table"
    end
    if not has_sidecar and file and ok_bl and BookList and BookList.hasBookBeenOpened and BookList.hasBookBeenOpened(file) then
        doc_settings_or_file = BookList.getDocSettings(file)
        has_sidecar = type(doc_settings_or_file) == "table"
    end

    local is_manga = false
    if file and type(file) == "string" and (file:lower():match("%.cbz$") or file:lower():match("%.cbr$") or file:lower():match("%.zip$")) then
        is_manga = true
    elseif has_sidecar and doc_settings_or_file and doc_settings_or_file.readSetting and doc_settings_or_file:readSetting("inverse_reading_order") == true then
        is_manga = true
    elseif book_props and (book_props.manga_type or book_props.total_chapters or book_props.status or book_props.associated_names) then
        is_manga = true
    end

    -- Extract passport fields from description text if missing in book_props
    local desc_text = book_props and book_props.description
    if is_manga and desc_text and type(desc_text) == "string" then
        book_props = book_props or {}
        if not book_props.associated_names then
            book_props.associated_names = desc_text:match("• Associated Name%(s%):%s*([^\n]+)")
                or desc_text:match("• Альтернативные названия:%s*([^\n]+)")
                or desc_text:match("• Другие названия:%s*([^\n]+)")
        end
        if not book_props.related_series then book_props.related_series = desc_text:match("• Связанные серии:%s*([^\n]+)") end
        if not book_props.status then book_props.status = desc_text:match("• Статус:%s*([^\n]+)") end
        if not book_props.manga_type then book_props.manga_type = desc_text:match("• Тип:%s*([^\n]+)") end
        if not book_props.released then book_props.released = desc_text:match("• Год релиза:%s*([^\n]+)") end
        if not book_props.official_translation then book_props.official_translation = desc_text:match("• Официальный перевод:%s*([^\n]+)") end
        if not book_props.anime_adaptation then book_props.anime_adaptation = desc_text:match("• Аниме%-адаптация:%s*([^\n]+)") end
        if not book_props.adult_content then book_props.adult_content = desc_text:match("• 18%+ Контент:%s*([^\n]+)") end
        if not book_props.total_chapters then book_props.total_chapters = desc_text:match("• Всего глав:%s*(%d+)") or desc_text:match("из (%d+) на сайте") end
        if not book_props.chapters_count then book_props.chapters_count = desc_text:match("• Глав в томе:%s*(%d+)") end
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
            local series_idx_pair = nil
            local has_type = false

            for pair_idx, pair in ipairs(options.kv_pairs) do
                local label = pair[1] or ""
                local clean = strip_icon(label)
                local val = pair[2]

                if not should_ignore(clean) and not is_empty(val) then
                    if clean == "Тип:" or clean == "Type:" or clean:find("Тип", 1, true) or clean:find("Type", 1, true) then
                        has_type = true
                        table.insert(kept, pair)
                    elseif clean == "Индекс серий:" or clean == "Series index:" or clean:find("Индекс", 1, true) then
                        series_idx_pair = pair
                    else
                        table.insert(kept, pair)
                    end
                end
            end

            -- Default manga type to "Manga" if not specified
            if not has_type then
                local def_val = (book_props and book_props.manga_type) or "Manga"
                table.insert(kept, { "Тип:", def_val })
            end

            if series_idx_pair then
                local label_str = tostring(series_idx_pair[1] or "")
                local p_icon = label_str:find("\u{F040}") and "\u{F040} " or ""
                series_idx_pair[1] = p_icon .. "Том:"
                table.insert(kept, series_idx_pair)
            end

            -- Sort by Manga priority map (Description, Associated names, Related series at top)
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
                    p.callback = function()
                        show_text_viewer(label_clean, val)
                    end
                end
            end

            -- Visual section separators:
            -- Separates top block (Description, Associated names, Related series) from specs, 18+, Cover
            for p_idx, p in ipairs(kept) do
                p.separator = false
                local c = strip_icon(p[1] or "")
                if c:find("Название", 1, true) or c:find("Title", 1, true)
                   or c:find("18+", 1, true) or c:find("Adult", 1, true)
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
