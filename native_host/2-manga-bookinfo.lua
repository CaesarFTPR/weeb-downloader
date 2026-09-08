--[[--
  KOReader User Patch: Manga Extended Metadata in Book Information
  Priority: 2 (Late - loaded after UIManager)
  Automatically adds custom manga metadata rows to KOReader's "Book Information"
  dialog when present in .sdr/custom_metadata.lua. For non-manga documents,
  these rows remain hidden to prevent clutter.
--]]--

local ok, BookInfo = pcall(require, "apps/filemanager/filemanagerbookinfo")
if not ok or not BookInfo or BookInfo._manga_custom_patched then
    return
end
BookInfo._manga_custom_patched = true

-- Custom manga properties and their user-friendly labels
local custom_props_map = {
    { key = "status",               label = "Статус:" },
    { key = "manga_type",           label = "Тип:" },
    { key = "chapters_count",       label = "Глав в томе:" },
    { key = "total_chapters",       label = "Всего глав:" },
    { key = "released",             label = "Год релиза:" },
    { key = "official_translation", label = "Офиц. перевод:" },
    { key = "anime_adaptation",     label = "Аниме:" },
    { key = "adult_content",        label = "18+ контент:" },
    { key = "related_series",       label = "Связанные серии:" },
    { key = "source",               label = "Источник:" },
    { key = "device_profile",       label = "Ридер:" },
}

for _, item in ipairs(custom_props_map) do
    if not BookInfo.prop_text[item.key] then
        table.insert(BookInfo.props, item.key)
        BookInfo.prop_text[item.key] = item.label
    end
end

-- Wrap BookInfo:show to cleanly filter out empty custom properties for regular books (EPUB/PDF)
local orig_show = BookInfo.show
BookInfo.show = function(self, doc_settings_or_file, book_props)
    local KeyValuePage = require("ui/widget/keyvaluepage")
    local orig_kvp_new = KeyValuePage.new
    KeyValuePage.new = function(kvp_class, options)
        KeyValuePage.new = orig_kvp_new
        if options and options.kv_pairs then
            local filtered = {}
            for _, pair in ipairs(options.kv_pairs) do
                local label = pair[1] or ""
                local val = pair[2]
                local is_custom = false
                for _, item in ipairs(custom_props_map) do
                    if label:find(item.label, 1, true) then
                        is_custom = true
                        break
                    end
                end
                -- If it's one of our custom properties, only display it if it has an actual value
                local is_na = (val == nil or val == "" or val == "nil" or val == "Н/Д" or val == "N/A")
                if not is_custom or not is_na then
                    table.insert(filtered, pair)
                end
            end
            options.kv_pairs = filtered
        end
        return orig_kvp_new(kvp_class, options)
    end
    return orig_show(self, doc_settings_or_file, book_props)
end
