--[[--
  KOReader User Patch: Manga Dedicated Book Information Card
  Version: 2.1.0
  Priority: 2 (Late - loaded after UIManager)

  Transforms KOReader's "Book Information" dialog for Manga/CBZ into a clean,
  dedicated Manga Card:
  1. Hides redundant technical filesystem rows (Filename, Format, Size, File date, Folder, Language, Rating, Review, Notebook).
  2. Places rich WeebCentral metadata right at the top (Title, Author, Type, Status, Chapters, Year, Translation, Anime, 18+, Genres, Volume, Pages, Cover, Synopsis).
  3. Displays everything on a single, elegant screen without multi-page pagination.
  4. Preserves 100% standard KOReader behavior for non-manga books (EPUB, PDF, FB2).
--]]--

local ok, BookInfo = pcall(require, "apps/filemanager/filemanagerbookinfo")
if not ok or not BookInfo or BookInfo._manga_custom_patched == "2.1.0" then
    return
end
BookInfo._manga_custom_patched = "2.1.0"

local BookList = require("apps/filemanager/filemanagerbooklist")
local DocSettings = require("docsettings")
local _ = require("gettext")

-- Custom manga properties and their user-friendly labels
local manga_props_defs = {
    { key = "manga_type",           label = "Тип:" },
    { key = "status",               label = "Статус:" },
    { key = "total_chapters",       label = "Всего глав:" },
    { key = "chapters_count",       label = "Глав в томе:" },
    { key = "released",             label = "Год релиза:" },
    { key = "official_translation", label = "Офиц. перевод:" },
    { key = "anime_adaptation",     label = "Аниме:" },
    { key = "adult_content",        label = "18+ контент:" },
    { key = "related_series",       label = "Связанные серии:" },
    { key = "source",               label = "Источник:" },
    { key = "device_profile",       label = "Ридер:" },
}

for _, item in ipairs(manga_props_defs) do
    if not BookInfo.prop_text[item.key] then
        table.insert(BookInfo.props, item.key)
        BookInfo.prop_text[item.key] = item.label
    end
end

local function strip_icon(str)
    if not str then return "" end
    return str:gsub("^%s*[\u{F040}%s]+", ""):gsub("^%s*", "")
end

local function is_empty(val)
    if val == nil then return true end
    local s = tostring(val):gsub("^%s*(.-)%s*$", "%1")
    return (s == "" or s == "nil" or s == "Н/Д" or s == "N/A")
end

-- Desired display priority for Manga Card in KOReader
local priority_map = {
    ["Название:"] = 1,
    ["Title:"] = 1,
    ["Автор(ы):"] = 2,
    ["Author(s):"] = 2,
    ["Тип:"] = 3,
    ["Type:"] = 3,
    ["Статус:"] = 4,
    ["Status:"] = 4,
    ["Всего глав:"] = 5,
    ["Total chapters:"] = 5,
    ["Глав в томе:"] = 6,
    ["Chapters count:"] = 6,
    ["Год релиза:"] = 7,
    ["Released:"] = 7,
    ["Офиц. перевод:"] = 8,
    ["Official translation:"] = 8,
    ["Аниме:"] = 9,
    ["Anime:"] = 9,
    ["18+ контент:"] = 10,
    ["Adult content:"] = 10,
    ["Связанные серии:"] = 11,
    ["Related series:"] = 11,
    ["Ключевые слова:"] = 12,
    ["Keywords:"] = 12,
    ["Серии:"] = 13,
    ["Series:"] = 13,
    ["Том:"] = 14,
    ["Индекс серий:"] = 14,
    ["Series index:"] = 14,
    ["Страниц:"] = 15,
    ["Pages:"] = 15,
    ["Обложка:"] = 16,
    ["Cover image:"] = 16,
    ["Описание:"] = 17,
    ["Description:"] = 17,
}

-- Fields to eliminate from Book Information for Manga (removes technical clutter)
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
    ["Review:"] = true,
    ["Файл блокнота:"] = true,
    ["Notebook file:"] = true,
    ["Current page:"] = true,
    ["Текущая страница:"] = true,
}

-- Wrap BookInfo:show to cleanly transform the manga view and keep regular books standard
local orig_show = BookInfo.show
BookInfo.show = function(self, doc_settings_or_file, book_props)
    local has_sidecar = type(doc_settings_or_file) == "table"
    local file = has_sidecar and doc_settings_or_file:readSetting("doc_path") or doc_settings_or_file
    if not has_sidecar and self.document and self.document.file == file then
        doc_settings_or_file = self.ui.doc_settings
        has_sidecar = true
    end
    if not has_sidecar and BookList.hasBookBeenOpened(file) then
        doc_settings_or_file = BookList.getDocSettings(file)
        has_sidecar = true
    end

    local is_manga = false
    if file and (file:lower():match("%.cbz$") or file:lower():match("%.cbr$") or file:lower():match("%.zip$")) then
        is_manga = true
    elseif has_sidecar and doc_settings_or_file:readSetting("inverse_reading_order") == true then
        is_manga = true
    elseif book_props and (book_props.manga_type or book_props.total_chapters or book_props.status) then
        is_manga = true
    end

    -- Extract passport fields from description text if missing in book_props
    local desc_text = book_props and book_props.description
    if is_manga and desc_text and type(desc_text) == "string" then
        book_props = book_props or {}
        if not book_props.status then book_props.status = desc_text:match("• Статус:%s*([^\n]+)") end
        if not book_props.manga_type then book_props.manga_type = desc_text:match("• Тип:%s*([^\n]+)") end
        if not book_props.released then book_props.released = desc_text:match("• Год релиза:%s*([^\n]+)") end
        if not book_props.official_translation then book_props.official_translation = desc_text:match("• Официальный перевод:%s*([^\n]+)") end
        if not book_props.anime_adaptation then book_props.anime_adaptation = desc_text:match("• Аниме%-адаптация:%s*([^\n]+)") end
        if not book_props.adult_content then book_props.adult_content = desc_text:match("• 18%+ Контент:%s*([^\n]+)") end
        if not book_props.related_series then book_props.related_series = desc_text:match("• Связанные серии:%s*([^\n]+)") end
        if not book_props.total_chapters then book_props.total_chapters = desc_text:match("• Всего глав:%s*(%d+)") or desc_text:match("из (%d+) на сайте") end
        if not book_props.chapters_count then book_props.chapters_count = desc_text:match("• Глав в томе:%s*(%d+)") end
    end

    local KeyValuePage = require("ui/widget/keyvaluepage")
    local orig_kvp_new = KeyValuePage.new
    KeyValuePage.new = function(kvp_class, options)
        KeyValuePage.new = orig_kvp_new
        if not options or not options.kv_pairs then
            return orig_kvp_new(kvp_class, options)
        end

        if not is_manga then
            -- Non-manga documents (EPUB/PDF): only remove empty custom manga properties
            local filtered = {}
            for _, pair in ipairs(options.kv_pairs) do
                local clean = strip_icon(pair[1] or "")
                local is_custom = false
                for _, def in ipairs(manga_props_defs) do
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
            return orig_kvp_new(kvp_class, options)
        end

        -- Dedicated Manga Card transformation
        local kept = {}
        local title_val = nil
        local series_pair = nil
        local series_idx_pair = nil
        local has_type = false

        for _, pair in ipairs(options.kv_pairs) do
            local label = pair[1] or ""
            local clean = strip_icon(label)
            local val = pair[2]

            if not ignore_fields[clean] and not is_empty(val) then
                if clean == "Название:" or clean == "Title:" or clean == _("Title:") then
                    title_val = tostring(val)
                    table.insert(kept, pair)
                elseif clean == "Тип:" or clean == "Type:" then
                    has_type = true
                    table.insert(kept, pair)
                elseif clean == "Серии:" or clean == "Series:" or clean == _("Series:") then
                    series_pair = pair
                elseif clean == "Индекс серий:" or clean == "Series index:" or clean == _("Series index:") then
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

        -- Clean up redundant Series vs Title
        if series_pair and title_val and tostring(series_pair[2]) ~= title_val then
            table.insert(kept, series_pair)
        end
        if series_idx_pair then
            local p_icon = series_idx_pair[1]:find("\u{F040}") and "\u{F040} " or ""
            series_idx_pair[1] = p_icon .. "Том:"
            table.insert(kept, series_idx_pair)
        end

        -- Sort by Manga priority map
        table.sort(kept, function(a, b)
            local pa = priority_map[strip_icon(a[1] or "")] or 90
            local pb = priority_map[strip_icon(b[1] or "")] or 90
            return pa < pb
        end)

        -- Smart visual section separators
        for _, p in ipairs(kept) do
            p.separator = false
            local c = strip_icon(p[1] or "")
            if c == "Автор(ы):" or c == "Author(s):" or c == _("Author(s):")
               or c == "18+ контент:" or c == "Adult content:"
               or c == "Связанные серии:" or c == "Related series:"
               or c == "Обложка:" or c == "Cover image:" or c == _("Cover image:") then
                p.separator = true
            end
        end

        options.kv_pairs = kept

        -- When items fit within a single screen, disable pagination footer
        if #kept <= 18 then
            options.single_page = true
        end

        return orig_kvp_new(kvp_class, options)
    end

    return orig_show(self, doc_settings_or_file, book_props)
end
