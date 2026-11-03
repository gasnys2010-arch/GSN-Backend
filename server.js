-- GSN Donation Experience - SERVER BRIDGE
-- Install as a normal Script in ServerScriptService.
-- Enable Game Settings > Security > Allow HTTP Requests.
-- Keep only ONE copy of this script enabled.

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

Players.CharacterAutoLoads = false

local API_BASE = "https://gsn-friend-pass.onrender.com"
local REMOTE_NAME = "GSN_SearchFriendPasses"
local COOLDOWN_SECONDS = 3

local remote = ReplicatedStorage:FindFirstChild(REMOTE_NAME)
if remote and not remote:IsA("RemoteFunction") then
    warn("[GSN] Existing object with remote name is not a RemoteFunction. Replacing it.")
    remote:Destroy()
    remote = nil
end
if not remote then
    remote = Instance.new("RemoteFunction")
    remote.Name = REMOTE_NAME
    remote.Parent = ReplicatedStorage
end

local lastRequest = {}

local function fail(message)
    return {ok=false, error=message}
end

local function cleanUsername(value)
    if typeof(value) ~= "string" then return nil end
    local username = string.gsub(value, "^%s*(.-)%s*$", "%1")
    if #username < 1 or #username > 20 then return nil end
    if not string.match(username, "^[%w_]+$") then return nil end
    return username
end

remote.OnServerInvoke = function(player, rawUsername)
    local username = cleanUsername(rawUsername)
    if not username then return fail("اكتب اسم Roblox صحيحاً.") end

    local now = os.clock()
    local previous = lastRequest[player.UserId] or 0
    if now - previous < COOLDOWN_SECONDS then
        return fail("انتظر 3 ثوانٍ قبل البحث مرة أخرى.")
    end
    lastRequest[player.UserId] = now

    local url = API_BASE .. "/search?username=" .. HttpService:UrlEncode(username)
    print("[GSN] Search requested by " .. player.Name .. " for " .. username)

    local requestOk, response = pcall(function()
        return HttpService:RequestAsync({
            Url=url, Method="GET",
            Headers={["Accept"]="application/json"}
        })
    end)

    if not requestOk then
        warn("[GSN] HTTP request exception: " .. tostring(response))
        return fail("تعذر اتصال Roblox بخادم GSN. تأكد من تفعيل Allow HTTP Requests.")
    end

    if not response.Success then
        warn("[GSN] Backend HTTP " .. tostring(response.StatusCode) .. ": " .. tostring(response.Body))
        local decoded
        pcall(function() decoded = HttpService:JSONDecode(response.Body) end)
        if type(decoded) == "table" and decoded.error then
            return fail(tostring(decoded.error))
        end
        return fail("خادم البحث رجّع HTTP " .. tostring(response.StatusCode))
    end

    local decodeOk, data = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)
    if not decodeOk or type(data) ~= "table" then
        warn("[GSN] Invalid JSON from backend.")
        return fail("وصل رد غير مفهوم من خادم البحث.")
    end
    if data.ok ~= true then return fail(tostring(data.error or "فشل البحث.")) end
    if type(data.data) ~= "table" or type(data.data.user) ~= "table" or type(data.data.passes) ~= "table" then
        warn("[GSN] Backend response schema mismatch.")
        return fail("بيانات البحث ناقصة من خادم GSN.")
    end

    print("[GSN] Search succeeded for " .. username .. "; passes=" .. tostring(#data.data.passes))
    return data
end

Players.PlayerRemoving:Connect(function(player)
    lastRequest[player.UserId] = nil
end)

print("[GSN] Server bridge ready; RemoteFunction=" .. REMOTE_NAME .. "; API=" .. API_BASE)
