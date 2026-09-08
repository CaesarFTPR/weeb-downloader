--[[
  merge_volume.lua
  -- version: 3.5.0
  True In-Place Binary CBZ Volume Merger for Kindle KOReader using native LuaJIT & libc.
  Time Complexity: O(delta) - appends new chapters in ~0.15s without rewriting existing chapters.

  Usage:
    /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua <target_cbz> <delta_zip>
    /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --inspect <target_cbz>
    /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --fix-meta <target_cbz>
    /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --delete <target_cbz> <key1> <key2> ...
--]]

local ffi = require("ffi")
ffi.cdef[[
    typedef struct FILE FILE;
    FILE *fopen(const char *path, const char *mode);
    int fclose(FILE *fp);
    int fseek(FILE *stream, long offset, int whence);
    long ftell(FILE *stream);
    size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream);
    size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream);
    int fileno(FILE *stream);
    int ftruncate(int fd, long length);
    int fflush(FILE *stream);
]]
local C = ffi.C

local function get_chapter_key(path)
    local first = path:match("^([^/]+)/") or path
    local first_lower = first:lower()
    if first_lower:find("cover") or first_lower:find("обложк") then
        return "cover"
    end
    -- First strip any leading index prefix (e.g. "08. ", "08.5. ", "08_ ", "08- ")
    local stripped = first_lower:gsub("^%d+%.?%d*[%._%-]%s*", "")
    -- Search in stripped first to avoid capturing the index prefix
    local num = stripped:match("chapter%s*([%d%.]+)") or
                stripped:match("ch%.?%s*([%d%.]+)") or
                stripped:match("глава%s*([%d%.]+)") or
                stripped:match("гл%.?%s*([%d%.]+)") or
                stripped:match("(%d+%.?%d*)") or
                first_lower:match("chapter%s*([%d%.]+)") or
                first_lower:match("ch%.?%s*([%d%.]+)") or
                first_lower:match("глава%s*([%d%.]+)") or
                first_lower:match("гл%.?%s*([%d%.]+)") or
                first_lower:match("(%d+%.?%d*)")
    if num and #num > 0 then
        num = num:gsub("%.$", "")
        local n = tonumber(num)
        if n then return "ch_" .. tostring(n) end
    end
    local clean = stripped:gsub("%s+", "_")
    if clean == "" then clean = first_lower:gsub("%s+", "_") end
    return clean
end

local function read_u16(s, pos)
    local b1, b2 = s:byte(pos, pos + 1)
    return b1 + b2 * 256
end

local function read_u32(s, pos)
    local b1, b2, b3, b4 = s:byte(pos, pos + 3)
    return b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
end

local function pack_u16(v)
    local b1 = v % 256
    local b2 = math.floor(v / 256) % 256
    return string.char(b1, b2)
end

local function pack_u32(v)
    local b1 = v % 256
    local b2 = math.floor(v / 256) % 256
    local b3 = math.floor(v / 65536) % 256
    local b4 = math.floor(v / 16777216) % 256
    return string.char(b1, b2, b3, b4)
end

local function find_eocd(fp)
    C.fseek(fp, 0, 2) -- SEEK_END
    local file_len = tonumber(C.ftell(fp))
    if file_len < 22 then return nil end
    local search_len = math.min(file_len, 65536 + 22)
    local search_start = file_len - search_len
    C.fseek(fp, search_start, 0) -- SEEK_SET

    local buf = ffi.new("char[?]", search_len)
    local read_bytes = tonumber(C.fread(buf, 1, search_len, fp))
    if read_bytes < 22 then return nil end
    local str = ffi.string(buf, read_bytes)

    local eocd_pos = nil
    local p = 1
    while true do
        local found = str:find("PK\5\6", p, true)
        if not found then break end
        eocd_pos = found
        p = found + 1
    end
    if not eocd_pos then return nil end

    local abs_eocd_pos = search_start + (eocd_pos - 1)
    local eocd_data = str:sub(eocd_pos, eocd_pos + 21)
    local total_entries = read_u16(eocd_data, 11)
    local cd_size = read_u32(eocd_data, 13)
    local cd_offset = read_u32(eocd_data, 17)

    return {
        file_len = file_len,
        offset = abs_eocd_pos,
        total_entries = total_entries,
        cd_size = cd_size,
        cd_offset = cd_offset
    }
end

local function parse_cd_entries(cd_str)
    local entries = {}
    local pos = 1
    local len = #cd_str
    while pos <= len do
        if cd_str:sub(pos, pos + 3) ~= "PK\1\2" then break end
        local n_len = read_u16(cd_str, pos + 28)
        local extra_len = read_u16(cd_str, pos + 30)
        local comm_len = read_u16(cd_str, pos + 32)
        local entry_len = 46 + n_len + extra_len + comm_len
        local fname = cd_str:sub(pos + 46, pos + 46 + n_len - 1)
        local entry_bytes = cd_str:sub(pos, pos + entry_len - 1)
        entries[#entries + 1] = {
            name = fname,
            bytes = entry_bytes
        }
        pos = pos + entry_len
    end
    return entries
end

local function serialize_lua_val(val, indent)
    local t = type(val)
    if t == "string" then
        return string.format("%q", val)
    elseif t == "number" or t == "boolean" then
        return tostring(val)
    elseif t == "table" then
        local parts = {"{\n"}
        local ind = string.rep("    ", indent + 1)
        for k, v in pairs(val) do
            local k_str = (type(k) == "number") and string.format("[%d]", k) or string.format("[%q]", tostring(k))
            parts[#parts + 1] = ind .. k_str .. " = " .. serialize_lua_val(v, indent + 1) .. ",\n"
        end
        parts[#parts + 1] = string.rep("    ", indent) .. "}"
        return table.concat(parts)
    else
        return "nil"
    end
end

local function update_koreader_metadata(target_cbz, pages)
    if not target_cbz or #target_cbz == 0 then return end
    local sdr_dir = target_cbz:gsub("%.%w+$", ".sdr")
    os.execute(string.format("mkdir -p %q 2>/dev/null", sdr_dir))
    local meta_file = sdr_dir .. "/metadata.cbz.lua"
    local meta_zip_file = sdr_dir .. "/metadata.zip.lua"

    local data = {}
    local chunk = loadfile(meta_file) or loadfile(meta_zip_file)
    if chunk then
        local ok, res = pcall(chunk)
        if ok and type(res) == "table" then
            data = res
        end
    end

    -- 1. Always enforce Right-To-Left manga reading direction for KOReader
    data["inverse_reading_order"] = true

    -- 2. Extract metadata from ComicInfo.xml inside target_cbz if present
    local xml_cmd = string.format("unzip -p %q ComicInfo.xml 2>/dev/null || unzip -p %q comicinfo.xml 2>/dev/null || busybox unzip -p %q ComicInfo.xml 2>/dev/null || busybox unzip -p %q comicinfo.xml 2>/dev/null", target_cbz, target_cbz, target_cbz, target_cbz)
    local p = io.popen(xml_cmd)
    local function unescape_xml(s)
        if not s then return nil end
        s = s:gsub("&amp;", "&")
        s = s:gsub("&lt;", "<")
        s = s:gsub("&gt;", ">")
        s = s:gsub("&quot;", '"')
        s = s:gsub("&apos;", "'")
        local trimmed = s:match("^%s*(.-)%s*$")
        return (#trimmed > 0) and trimmed or nil
    end

    data["doc_props"] = data["doc_props"] or {}

    if p then
        local xml = p:read("*a")
        p:close()
        if xml and #xml > 0 then
            local title = unescape_xml(xml:match("<Title>(.-)</Title>") or xml:match("<Series>(.-)</Series>"))
            local series = unescape_xml(xml:match("<Series>(.-)</Series>") or xml:match("<Title>(.-)</Title>"))
            local writer = unescape_xml(xml:match("<Writer>(.-)</Writer>") or xml:match("<Penciller>(.-)</Penciller>"))
            local summary = unescape_xml(xml:match("<Summary>(.-)</Summary>"))
            local genre = unescape_xml(xml:match("<Genre>(.-)</Genre>"))
            local volume = unescape_xml(xml:match("<Volume>(.-)</Volume>"))
            local number = unescape_xml(xml:match("<Number>(.-)</Number>"))
            local count = unescape_xml(xml:match("<Count>(.-)</Count>"))
            local fmt = unescape_xml(xml:match("<Format>(.-)</Format>"))
            local year = unescape_xml(xml:match("<Year>(.-)</Year>"))
            local age_rating = unescape_xml(xml:match("<AgeRating>(.-)</AgeRating>"))
            local scan_info = unescape_xml(xml:match("<ScanInformation>(.-)</ScanInformation>"))

            local status = unescape_xml(xml:match("<Status>(.-)</Status>"))
            local official_translation = unescape_xml(xml:match("<OfficialTranslation>(.-)</OfficialTranslation>"))
            local anime_adaptation = unescape_xml(xml:match("<AnimeAdaptation>(.-)</AnimeAdaptation>"))
            local related_series = unescape_xml(xml:match("<RelatedSeries>(.-)</RelatedSeries>"))
            local chapters_count = unescape_xml(xml:match("<ChaptersCount>(.-)</ChaptersCount>"))

            -- Also extract from summary passport if present
            if not status and summary then status = summary:match("• Статус:%s*([^\n]+)") end
            if not fmt and summary then fmt = summary:match("• Тип:%s*([^\n]+)") end
            if not year and summary then year = summary:match("• Год релиза:%s*([^\n]+)") end
            if not official_translation and summary then official_translation = summary:match("• Официальный перевод:%s*([^\n]+)") end
            if not anime_adaptation and summary then anime_adaptation = summary:match("• Аниме%-адаптация:%s*([^\n]+)") end
            if not age_rating and summary then age_rating = summary:match("• 18%+ Контент:%s*([^\n]+)") end
            if not related_series and summary then related_series = summary:match("• Связанные серии:%s*([^\n]+)") end
            if not count and summary then count = summary:match("• Всего глав:%s*(%d+)") or summary:match("из (%d+) на сайте") end
            if not chapters_count and summary then chapters_count = summary:match("• Глав в томе:%s*(%d+)") end

            if title then
                data["doc_props"]["title"] = title
                data["doc_props"]["display_title"] = title
            end
            if series then data["doc_props"]["series"] = series end
            if writer then data["doc_props"]["authors"] = writer end
            if summary then data["doc_props"]["description"] = summary end
            if genre then data["doc_props"]["keywords"] = genre end
            if volume and tonumber(volume) then
                data["doc_props"]["series_index"] = tonumber(volume)
            elseif number and tonumber(number) then
                data["doc_props"]["series_index"] = tonumber(number)
            end
            if count then data["doc_props"]["total_chapters"] = count end
            if chapters_count then data["doc_props"]["chapters_count"] = chapters_count end
            if fmt then data["doc_props"]["manga_type"] = fmt end
            if status then data["doc_props"]["status"] = status end
            if year then data["doc_props"]["released"] = year end
            if official_translation then data["doc_props"]["official_translation"] = official_translation end
            if anime_adaptation then data["doc_props"]["anime_adaptation"] = anime_adaptation end
            if related_series then data["doc_props"]["related_series"] = related_series end
            if age_rating then
                data["doc_props"]["adult_content"] = (age_rating:find("18") or age_rating:lower():find("adult")) and "Yes" or "No"
            end
            if scan_info then data["doc_props"]["source"] = scan_info end
            data["doc_props"]["language"] = "en"
            data["doc_props"]["device_profile"] = "Kindle 11 (1236×1648)"
        end
    end

    -- Fallback title/series from filename if missing
    local stem_name = target_cbz:match("([^/]+)%.%w+$") or target_cbz
    if not data["doc_props"]["title"] then
        data["doc_props"]["title"] = stem_name
        data["doc_props"]["display_title"] = stem_name
    end
    if not data["doc_props"]["series"] then
        data["doc_props"]["series"] = stem_name
    end
    if not data["doc_props"]["series_index"] then
        local vol_num = stem_name:match("v(?:ol(?:ume)?)?[._%s-]*0*(%d+)")
        if vol_num and tonumber(vol_num) then
            data["doc_props"]["series_index"] = tonumber(vol_num)
        else
            data["doc_props"]["series_index"] = 1
        end
    end

    if pages and pages > 0 then
        data["doc_props"]["pages"] = pages
    end

    local serialized = "-- Generated by WeebCentral Kindle Downloader\nreturn " .. serialize_lua_val(data, 0) .. "\n"
    local f_out = io.open(meta_file, "w")
    if f_out then
        f_out:write(serialized)
        f_out:close()
    end
    local f_zip_out = io.open(meta_zip_file, "w")
    if f_zip_out then
        f_zip_out:write(serialized)
        f_zip_out:close()
    end

    -- Write custom_metadata.lua which KOReader never overwrites upon document open
    if data["doc_props"] then
        local custom_data = {
            ["custom_props"] = data["doc_props"],
            ["doc_props"] = data["doc_props"]
        }
        local custom_serialized = "-- Generated by WeebCentral Kindle Downloader\nreturn " .. serialize_lua_val(custom_data, 0) .. "\n"
        local f_custom = io.open(sdr_dir .. "/custom_metadata.lua", "w")
        if f_custom then
            f_custom:write(custom_serialized)
            f_custom:close()
        end
    end
end

-- Fix Metadata mode: writes/updates KOReader sidecar .sdr/metadata.cbz.lua
if arg[1] == "--fix-meta" then
    local target_cbz = arg[2]
    if not target_cbz then
        io.write('{"status":"error","message":"No volume path provided"}\n')
        os.exit(1)
    end
    update_koreader_metadata(target_cbz)
    io.write('{"status":"success","action":"meta_fixed"}\n')
    os.exit(0)
end

-- Inspect mode: instantaneous Central Directory scan + KOReader .sdr metadata reading
if arg[1] == "--inspect" then
    local target_cbz = arg[2]
    if not target_cbz then
        io.write('{"status":"error","message":"No volume path provided"}\n')
        os.exit(1)
    end

    local fp = C.fopen(target_cbz, "rb")
    if fp == nil then
        io.write('{"status":"success","exists":false,"chapters":[],"chapter_keys":[]}\n')
        os.exit(0)
    end

    local eocd = find_eocd(fp)
    if not eocd then
        C.fclose(fp)
        io.write('{"status":"error","message":"Invalid or unreadable ZIP archive"}\n')
        os.exit(1)
    end

    C.fseek(fp, eocd.cd_offset, 0)
    local cd_buf = ffi.new("char[?]", eocd.cd_size)
    local read_cd = tonumber(C.fread(cd_buf, 1, eocd.cd_size, fp))
    C.fclose(fp)

    local cd_str = ffi.string(cd_buf, read_cd or 0)
    local entries = parse_cd_entries(cd_str)

    local seen_folders = {}
    local folders = {}
    local keys = {}
    local image_count = 0
    local page_to_chapter = {}

    for _, e in ipairs(entries) do
        local path = e.name
        local folder = path:match("^([^/]+)/")
        local ext = path:match("%.([%w]+)$")
        if ext then
            ext = ext:lower()
            if ext == "jpg" or ext == "jpeg" or ext == "png" or ext == "webp" or ext == "gif" or ext == "avif" then
                image_count = image_count + 1
                page_to_chapter[image_count] = folder or path
            end
        end

        if folder then
            if not seen_folders[folder] then
                seen_folders[folder] = true
                local k = get_chapter_key(folder)
                if k and k ~= "cover" then
                    folders[#folders + 1] = folder
                    keys[#keys + 1] = k
                end
            end
        else
            local k = get_chapter_key(path)
            local p_lower = path:lower()
            if k and k ~= "cover" and p_lower ~= "comicinfo.xml" and p_lower ~= "toc.ncx" then
                if not seen_folders[k] then
                    seen_folders[k] = true
                    folders[#folders + 1] = path
                    keys[#keys + 1] = k
                end
            end
        end
    end

    -- Read KOReader .sdr metadata for live reading progress
    local reading_progress = nil
    local sdr_dir = target_cbz:gsub("%.%w+$", ".sdr")

    -- Auto-heal KOReader custom metadata sidecar if missing on Kindle
    local f_custom_check = io.open(sdr_dir .. "/custom_metadata.lua", "r")
    if f_custom_check then
        f_custom_check:close()
    else
        update_koreader_metadata(target_cbz, image_count)
    end
    local meta_candidates = {
        sdr_dir .. "/metadata.cbz.lua",
        sdr_dir .. "/metadata.zip.lua"
    }
    for _, meta_file in ipairs(meta_candidates) do
        local f_meta = io.open(meta_file, "r")
        if f_meta then
            f_meta:close()
            local chunk = loadfile(meta_file)
            if chunk then
                local ok, mdata = pcall(chunk)
                if ok and type(mdata) == "table" then
                    local last_p = mdata.last_page or mdata.page or 1
                    local pct = mdata.percent_finished or 0
                    if pct > 0 or last_p > 1 then
                        local cur_ch = page_to_chapter[last_p]
                        reading_progress = {
                            last_page = last_p,
                            percent = math.floor(pct * 100 + 0.5),
                            chapter = cur_ch,
                            chapter_key = cur_ch and get_chapter_key(cur_ch) or nil,
                            total_pages = image_count
                        }
                    end
                    break
                end
            end
        end
    end

    local json_folders = {}
    for _, f in ipairs(folders) do
        json_folders[#json_folders + 1] = string.format("%q", f)
    end
    local json_keys = {}
    for _, k in ipairs(keys) do
        json_keys[#json_keys + 1] = string.format("%q", k)
    end

    local json_prog = "null"
    if reading_progress then
        local ch_str = reading_progress.chapter and string.format("%q", reading_progress.chapter) or "null"
        local chk_str = reading_progress.chapter_key and string.format("%q", reading_progress.chapter_key) or "null"
        json_prog = string.format('{"last_page":%d,"percent":%d,"chapter":%s,"chapter_key":%s,"total_pages":%d}',
            reading_progress.last_page, reading_progress.percent, ch_str, chk_str, reading_progress.total_pages)
    end
    update_koreader_metadata(target_cbz, image_count)

    io.write(string.format('{"status":"success","exists":true,"chapters":[%s],"chapter_keys":[%s],"total_pages":%d,"reading_progress":%s}\n',
        table.concat(json_folders, ","), table.concat(json_keys, ","), image_count, json_prog))
    os.exit(0)
end

-- Delete mode: instant removal of specified chapter keys from Central Directory
if arg[1] == "--delete" then
    local target_cbz = arg[2]
    if not target_cbz then
        io.write('{"status":"error","message":"No volume path provided"}\n')
        os.exit(1)
    end

    local del_keys = {}
    for i = 3, #arg do
        del_keys[arg[i]:lower()] = true
    end

    local fp = C.fopen(target_cbz, "r+b")
    if fp == nil then
        io.write('{"status":"error","message":"Target file not found"}\n')
        os.exit(0)
    end

    local eocd = find_eocd(fp)
    if not eocd then
        C.fclose(fp)
        io.write('{"status":"error","message":"Invalid or unreadable ZIP archive"}\n')
        os.exit(1)
    end

    C.fseek(fp, eocd.cd_offset, 0)
    local cd_buf = ffi.new("char[?]", eocd.cd_size)
    local read_cd = tonumber(C.fread(cd_buf, 1, eocd.cd_size, fp))
    if read_cd < eocd.cd_size then
        C.fclose(fp)
        io.write('{"status":"error","message":"Could not read Central Directory"}\n')
        os.exit(1)
    end

    local cd_str = ffi.string(cd_buf, read_cd or 0)
    local entries = parse_cd_entries(cd_str)

    -- Determine unique chapters
    local all_keys = {}
    for _, e in ipairs(entries) do
        local n_lower = e.name:lower()
        if n_lower ~= "comicinfo.xml" and n_lower ~= "toc.ncx" then
            local k = get_chapter_key(e.name)
            if k and k ~= "cover" then
                all_keys[k] = true
            end
        end
    end

    -- Check how many chapters remain
    local remaining_count = 0
    for k, _ in pairs(all_keys) do
        if not del_keys[k] then
            remaining_count = remaining_count + 1
        end
    end

    if remaining_count == 0 then
        -- All chapters are removed! Delete the volume file and .sdr directory
        C.fclose(fp)
        os.remove(target_cbz)
        local base_no_ext = target_cbz:gsub("%.cbz$", ""):gsub("%.zip$", "")
        local sdr_dir = base_no_ext .. ".sdr"
        os.execute("rm -rf '" .. sdr_dir:gsub("'", "'\\''") .. "' '" .. target_cbz:gsub("'", "'\\''") .. "' 2>/dev/null")
        io.write('{"status":"success","action":"volume_removed"}\n')
        os.exit(0)
    end

    -- Filter CD entries
    local kept_cd = {}
    local deleted_entries_count = 0
    for _, e in ipairs(entries) do
        local n_lower = e.name:lower()
        local should_delete = false
        if n_lower ~= "comicinfo.xml" and n_lower ~= "toc.ncx" then
            local k = get_chapter_key(e.name)
            if k and del_keys[k] then
                should_delete = true
            end
        end

        if should_delete then
            deleted_entries_count = deleted_entries_count + 1
        else
            kept_cd[#kept_cd + 1] = e.bytes
        end
    end

    -- Write new Central Directory at eocd.cd_offset
    C.fseek(fp, eocd.cd_offset, 0)
    for _, b in ipairs(kept_cd) do
        C.fwrite(b, 1, #b, fp)
    end
    local new_cd_size = tonumber(C.ftell(fp)) - eocd.cd_offset
    local total_kept_entries = #kept_cd

    -- Write new EOCD
    local new_eocd = "PK\5\6" .. "\0\0\0\0" ..
                     pack_u16(total_kept_entries) .. pack_u16(total_kept_entries) ..
                     pack_u32(new_cd_size) .. pack_u32(eocd.cd_offset) .. "\0\0"
    C.fwrite(new_eocd, 1, #new_eocd, fp)
    C.fflush(fp)

    local final_pos = tonumber(C.ftell(fp))
    local fd = C.fileno(fp)
    local trunc_ok = pcall(function() C.ftruncate(fd, final_pos) end)
    if not trunc_ok then
        os.execute(string.format("truncate -s %d %q 2>/dev/null", final_pos, target_cbz))
    end
    C.fclose(fp)

    os.execute("touch '" .. target_cbz:gsub("'", "'\\''") .. "' 2>/dev/null")
    update_koreader_metadata(target_cbz, total_kept_entries)
    io.write(string.format('{"status":"success","action":"chapters_deleted","deleted_entries":%d,"remaining_chapters":%d}\n', deleted_entries_count, remaining_count))
    os.exit(0)
end

-- Merge mode
local target_cbz = arg[1]
local delta_zip = arg[2]

if not target_cbz or not delta_zip then
    io.write('{"status":"error","message":"Usage: luajit merge_volume.lua <target_cbz> <delta_zip>"}\n')
    os.exit(1)
end

local f_test_delta = io.open(delta_zip, "rb")
if not f_test_delta then
    io.write('{"status":"error","message":"Delta file not found: ' .. tostring(delta_zip) .. '"}\n')
    os.exit(1)
end
f_test_delta:close()

-- If target does not exist yet, promote delta directly to target
local f_test_target = io.open(target_cbz, "rb")
if not f_test_target then
    local parent = target_cbz:match("(.+)/[^/]+$")
    if parent then
        os.execute("mkdir -p '" .. parent:gsub("'", "'\\''") .. "'")
    end
    local ok, err = os.rename(delta_zip, target_cbz)
    if not ok then
        local cp_ok = os.execute("cp -f '" .. delta_zip .. "' '" .. target_cbz .. "' && rm -f '" .. delta_zip .. "'")
        if cp_ok ~= 0 then
            io.write('{"status":"error","message":"Failed to move delta to target: ' .. tostring(err) .. '"}\n')
            os.exit(1)
        end
    end
    update_koreader_metadata(target_cbz)
    io.write('{"status":"success","action":"created","target":"' .. target_cbz .. '"}\n')
    os.exit(0)
end
f_test_target:close()

-- Target exists. Perform True In-Place Binary ZIP Append (O(delta))
local f_target = C.fopen(target_cbz, "r+b")
if f_target == nil then
    io.write('{"status":"error","message":"Cannot open target for writing: ' .. target_cbz .. '"}\n')
    os.exit(1)
end

local f_delta = C.fopen(delta_zip, "rb")
if f_delta == nil then
    C.fclose(f_target)
    io.write('{"status":"error","message":"Cannot open delta for reading: ' .. delta_zip .. '"}\n')
    os.exit(1)
end

local t_eocd = find_eocd(f_target)
local d_eocd = find_eocd(f_delta)

if not t_eocd or not d_eocd then
    C.fclose(f_target)
    C.fclose(f_delta)
    io.write('{"status":"error","message":"Invalid target or delta ZIP structure"}\n')
    os.exit(1)
end

-- Read old Central Directory
C.fseek(f_target, t_eocd.cd_offset, 0)
local old_cd_buf = ffi.new("char[?]", t_eocd.cd_size)
C.fread(old_cd_buf, 1, t_eocd.cd_size, f_target)
local old_cd_str = ffi.string(old_cd_buf, t_eocd.cd_size)

-- Read delta Central Directory
C.fseek(f_delta, d_eocd.cd_offset, 0)
local delta_cd_buf = ffi.new("char[?]", d_eocd.cd_size)
C.fread(delta_cd_buf, 1, d_eocd.cd_size, f_delta)
local delta_cd_str = ffi.string(delta_cd_buf, d_eocd.cd_size)

local old_entries = parse_cd_entries(old_cd_str)
local delta_entries = parse_cd_entries(delta_cd_str)

-- Identify delta filenames and chapter keys
local delta_names = {}
local delta_keys = {}
for _, e in ipairs(delta_entries) do
    local n_lower = e.name:lower()
    delta_names[n_lower] = true
    if n_lower ~= "comicinfo.xml" and n_lower ~= "toc.ncx" then
        local k = get_chapter_key(e.name)
        if k then delta_keys[k] = true end
    end
end

-- Filter old entries: drop files in delta (ComicInfo.xml, toc.ncx), chapters overridden by delta, and older duplicate folders
local kept_old_cd = {}
local kept_old_count = 0
local seen_old_folders = {}

for _, e in ipairs(old_entries) do
    local n_lower = e.name:lower()
    local should_skip = false
    if delta_names[n_lower] then
        should_skip = true
    elseif n_lower ~= "comicinfo.xml" and n_lower ~= "toc.ncx" then
        local k = get_chapter_key(e.name)
        if k and delta_keys[k] then
            should_skip = true
        elseif k and k ~= "other" then
            local folder = e.name:match("^([^/]+)/") or ""
            if not seen_old_folders[k] then
                seen_old_folders[k] = folder
            elseif seen_old_folders[k] ~= folder then
                should_skip = true
            end
        end
    end

    if not should_skip then
        kept_old_cd[#kept_old_cd + 1] = e.bytes
        kept_old_count = kept_old_count + 1
    end
end

-- Adjust delta local header offsets by adding t_eocd.cd_offset
local adj_delta_cd = {}
for _, e in ipairs(delta_entries) do
    local entry_str = e.bytes
    local local_offset = read_u32(entry_str, 43)
    local new_local_offset = local_offset + t_eocd.cd_offset
    local adj_entry = entry_str:sub(1, 42) .. pack_u32(new_local_offset) .. entry_str:sub(47)
    adj_delta_cd[#adj_delta_cd + 1] = adj_entry
end

-- Seek to t_eocd.cd_offset in target and append delta payload directly
C.fseek(f_target, t_eocd.cd_offset, 0)
C.fseek(f_delta, 0, 0)
local remaining = d_eocd.cd_offset
local chunk_size = 65536
local stream_buf = ffi.new("char[?]", chunk_size)
while remaining > 0 do
    local to_read = math.min(remaining, chunk_size)
    local n = tonumber(C.fread(stream_buf, 1, to_read, f_delta))
    if n <= 0 then break end
    C.fwrite(stream_buf, 1, n, f_target)
    remaining = remaining - n
end

-- Write new Central Directory
local new_cd_offset = tonumber(C.ftell(f_target))
for _, b in ipairs(kept_old_cd) do
    C.fwrite(b, 1, #b, f_target)
end
for _, b in ipairs(adj_delta_cd) do
    C.fwrite(b, 1, #b, f_target)
end
local new_cd_size = tonumber(C.ftell(f_target)) - new_cd_offset

-- Write new EOCD record
local total_new_entries = kept_old_count + #delta_entries
local new_eocd = "PK\5\6" .. "\0\0\0\0" ..
                 pack_u16(total_new_entries) .. pack_u16(total_new_entries) ..
                 pack_u32(new_cd_size) .. pack_u32(new_cd_offset) .. "\0\0"
C.fwrite(new_eocd, 1, #new_eocd, f_target)
C.fflush(f_target)

local final_pos = tonumber(C.ftell(f_target))
local fd = C.fileno(f_target)
local trunc_ok = pcall(function() C.ftruncate(fd, final_pos) end)
if not trunc_ok then
    os.execute(string.format("truncate -s %d %q 2>/dev/null", final_pos, target_cbz))
end

C.fclose(f_target)
C.fclose(f_delta)

os.remove(delta_zip)

update_koreader_metadata(target_cbz, total_new_entries)

io.write(string.format('{"status":"success","action":"merged","entries":%d,"target":%q}\n', total_new_entries, target_cbz))
