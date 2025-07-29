import { RedisClientType } from 'redis';
import { MusicTrack } from '../types';
import * as crypto from 'crypto';

export interface CachedMusicTrack extends MusicTrack {
    cachedAt: number;
    searchQuery: string;
    hitCount?: number;
    lastAccessed?: number;
}

export class MusicCache {
    private redisClient: RedisClientType;
    private readonly CACHE_PREFIX = 'music:';
    private readonly CACHE_TTL = 30 * 24 * 60 * 60; // 30 days
    private readonly POPULAR_SONG_TTL = 60 * 24 * 60 * 60; // 60 days for popular songs
    private readonly STATS_PREFIX = 'music-stats:';

    constructor(redisClient: RedisClientType) {
        this.redisClient = redisClient;
    }

    // Generate normalized cache key from song metadata
    private generateCacheKey(query: string, source: string): string {
        // Check if it's a URL (YouTube, Spotify, etc.)
        if (query.includes('://') || query.includes('youtube.com') || query.includes('spotify.com')) {
            // For URLs, use the full URL as the key (just normalize case and whitespace)
            const normalized = query.toLowerCase().trim();
            const hash = crypto.createHash('md5').update(normalized).digest('hex');
            return `${this.CACHE_PREFIX}${source.toLowerCase()}:url:${hash}`;
        }
        
        // For search queries (song titles, artist names, etc.)
        const normalized = query.toLowerCase()
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/[^\w\s-]/g, '') // Remove special characters only for search queries
            .substring(0, 100); // Limit length
        
        const hash = crypto.createHash('md5').update(normalized).digest('hex');
        return `${this.CACHE_PREFIX}${source.toLowerCase()}:search:${hash}`;
    }

    // Generate cache key for specific IDs
    private generateIdCacheKey(id: string, source: string): string {
        return `${this.CACHE_PREFIX}id:${source.toLowerCase()}:${id}`;
    }

    // Cache song with multiple identifiers for maximum hit rate
    async cacheSong(song: MusicTrack, searchQuery: string): Promise<void> {
        const cacheData: CachedMusicTrack = {
            ...song,
            cachedAt: Date.now(),
            searchQuery: searchQuery.toLowerCase().trim(),
            hitCount: 0,
            lastAccessed: Date.now()
        };

        const promises: Promise<any>[] = [];
        const ttl = this.CACHE_TTL;
        
        try {
            // Check if searchQuery is a URL
            const isUrl = searchQuery.includes('://') || searchQuery.includes('youtube.com') || searchQuery.includes('spotify.com');
            
            if (isUrl) {
                // For URLs, only cache by the exact URL and extracted ID
                const queryKey = this.generateCacheKey(searchQuery, song.source);
                promises.push(this.redisClient.setEx(queryKey, ttl, JSON.stringify(cacheData)));
                
                // Cache by specific ID if available
                if (song.extractedId) {
                    const idKey = this.generateIdCacheKey(song.extractedId, song.source);
                    promises.push(this.redisClient.setEx(idKey, ttl, JSON.stringify(cacheData)));
                }
            } else {
                // For search queries (song titles, etc.), cache by multiple identifiers
                // 1. Cache by search query
                const queryKey = this.generateCacheKey(searchQuery, song.source);
                promises.push(this.redisClient.setEx(queryKey, ttl, JSON.stringify(cacheData)));
                
                // 2. Cache by song title
                if (song.title) {
                    const titleKey = this.generateCacheKey(song.title, song.source);
                    promises.push(this.redisClient.setEx(titleKey, ttl, JSON.stringify(cacheData)));
                }
                
                // 3. Cache by song title + artist combination
                if (song.title && song.artist) {
                    const combinedQuery = `${song.title} ${song.artist}`;
                    const combinedKey = this.generateCacheKey(combinedQuery, song.source);
                    promises.push(this.redisClient.setEx(combinedKey, ttl, JSON.stringify(cacheData)));
                }
                
                // 4. Cache by specific IDs
                if (song.extractedId) {
                    const idKey = this.generateIdCacheKey(song.extractedId, song.source);
                    promises.push(this.redisClient.setEx(idKey, ttl, JSON.stringify(cacheData)));
                }

                // 5. Add to search index for fuzzy matching (only for search queries, not URLs)
                const searchIndexKey = `${this.CACHE_PREFIX}search-index:${song.source.toLowerCase()}`;
                const searchData = {
                    key: queryKey,
                    title: song.title,
                    artist: song.artist || '',
                    searchQuery: searchQuery.toLowerCase()
                };
                promises.push(this.redisClient.zAdd(searchIndexKey, {
                    score: Date.now(),
                    value: JSON.stringify(searchData)
                }));
            }

            await Promise.all(promises);
            
            // Update cache statistics
            await this.updateCacheStats('songs_cached', 1);
            
            console.log(`[MusicCache] ✅ Cached song: "${song.title}" with ${promises.length - 1} keys (${isUrl ? 'URL' : 'Search'} type)`);
        } catch (error) {
            console.error(`[MusicCache] ❌ Error caching song:`, error);
            throw error;
        }
    }

    // Smart search in cache with fuzzy matching
    async searchCache(query: string, source?: string): Promise<CachedMusicTrack | null> {
        const searchStart = Date.now();
        
        try {
            const directResult = await this.directSearch(query, source);
            if (directResult) {
                await this.updateHitStats(directResult, Date.now() - searchStart);
                return directResult;
            }

            // Only use fuzzy search for non-URL queries
            const isUrl = query.includes('://') || query.includes('youtube.com') || query.includes('spotify.com');
            
            if (!isUrl) {
                // Fuzzy search only for search queries (song titles, artist names, etc.)
                const fuzzyResult = await this.fuzzySearch(query, source);
                if (fuzzyResult) {
                    await this.updateHitStats(fuzzyResult, Date.now() - searchStart);
                    return fuzzyResult;
                }
            }

            await this.updateCacheStats('cache_misses', 1);
            console.log(`[MusicCache] ❌ Cache MISS for: "${query}" (${Date.now() - searchStart}ms) - ${isUrl ? 'URL' : 'Search'} type`);
            return null;
        } catch (error) {
            console.error(`[MusicCache] Error searching cache for "${query}":`, error);
            return null;
        }
    }

    private async directSearch(query: string, source?: string): Promise<CachedMusicTrack | null> {
        const searchKeys: string[] = [];
        
        if (source) {
            searchKeys.push(this.generateCacheKey(query, source));
        } else {
            // Search in all sources
            searchKeys.push(this.generateCacheKey(query, 'Youtube'));
            searchKeys.push(this.generateCacheKey(query, 'Spotify'));
        }

        for (const key of searchKeys) {
            try {
                const cached = await this.redisClient.get(key);
                if (cached) {
                    const song = JSON.parse(cached) as CachedMusicTrack;
                    song.lastAccessed = Date.now();
                    // Update last accessed time
                    await this.redisClient.setEx(key, this.CACHE_TTL, JSON.stringify(song));
                    
                    // Add detailed logging to debug cache hits
                    console.log(`[MusicCache] 🎯 Direct cache hit for query: "${query}" -> Found song: "${song.title}" (ID: ${song.id || song.extractedId})`);
                    
                    return song;
                }
            } catch (error) {
                console.error(`[MusicCache] Error reading cache key ${key}:`, error);
            }
        }
        
        return null;
    }

    private async fuzzySearch(query: string, source?: string): Promise<CachedMusicTrack | null> {
        const sources = source ? [source] : ['Youtube', 'Spotify'];
        const queryLower = query.toLowerCase();
        
        for (const src of sources) {
            try {
                const searchIndexKey = `${this.CACHE_PREFIX}search-index:${src.toLowerCase()}`;
                const results = await this.redisClient.zRange(searchIndexKey, 0, -1);
                
                for (const result of results) {
                    try {
                        const searchData = JSON.parse(result);
                        const { title, artist, searchQuery } = searchData;
                        
                        // Simple fuzzy matching
                        if (this.isFuzzyMatch(queryLower, title, artist, searchQuery)) {
                            const cached = await this.redisClient.get(searchData.key);
                            if (cached) {
                                return JSON.parse(cached) as CachedMusicTrack;
                            }
                        }
                    } catch (parseError) {
                        // Skip invalid entries
                        continue;
                    }
                }
            } catch (error) {
                console.error(`[MusicCache] Error in fuzzy search for ${src}:`, error);
            }
        }
        
        return null;
    }

    private isFuzzyMatch(query: string, title: string, artist: string, originalQuery: string): boolean {
        const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
        const titleWords = (title?.toLowerCase() || '').split(/\s+/).filter(word => word.length > 2);
        const artistWords = (artist?.toLowerCase() || '').split(/\s+/).filter(word => word.length > 2);
        const originalWords = (originalQuery?.toLowerCase() || '').split(/\s+/).filter(word => word.length > 2);

        // For song matching, require more strict criteria
        // At least 60% of query words should match in the target
        const minMatchRatio = 0.6;
        
        const targets = [
            { words: titleWords, name: 'title' },
            { words: [...titleWords, ...artistWords], name: 'title+artist' },
            { words: originalWords, name: 'original' }
        ];

        for (const target of targets) {
            if (target.words.length === 0) continue;
            
            let matchedWords = 0;
            for (const queryWord of queryWords) {
                if (target.words.some(targetWord => 
                    targetWord.includes(queryWord) || 
                    queryWord.includes(targetWord) ||
                    this.calculateSimilarity(queryWord, targetWord) > 0.8
                )) {
                    matchedWords++;
                }
            }
            
            const matchRatio = matchedWords / queryWords.length;
            if (matchRatio >= minMatchRatio && matchedWords >= 2) {
                console.log(`[MusicCache] 🎯 Fuzzy match found: "${query}" -> "${title}" by "${artist}" (${Math.round(matchRatio * 100)}% match)`);
                return true;
            }
        }
        
        // Fallback: exact string similarity for short queries
        if (query.length <= 20) {
            const targets = [
                title?.toLowerCase() || '',
                `${title} ${artist}`.toLowerCase(),
                originalQuery?.toLowerCase() || ''
            ].filter(Boolean);

            return targets.some(target => this.calculateSimilarity(query, target) > 0.85);
        }

        return false;
    }

    private calculateSimilarity(str1: string, str2: string): number {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) return 1.0;
        
        const editDistance = this.levenshteinDistance(longer, shorter);
        return (longer.length - editDistance) / longer.length;
    }

    private levenshteinDistance(str1: string, str2: string): number {
        const matrix = Array(str2.length + 1).fill(null).map(() => 
            Array(str1.length + 1).fill(null)
        );

        for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
        for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

        for (let j = 1; j <= str2.length; j++) {
            for (let i = 1; i <= str1.length; i++) {
                const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(
                    matrix[j][i - 1] + 1,
                    matrix[j - 1][i] + 1,
                    matrix[j - 1][i - 1] + indicator
                );
            }
        }

        return matrix[str2.length][str1.length];
    }

    // Get song by specific platform ID
    async getBySpotifyId(spotifyId: string): Promise<CachedMusicTrack | null> {
        const key = this.generateIdCacheKey(spotifyId, 'Spotify');
        const cached = await this.redisClient.get(key);
        return cached ? JSON.parse(cached) : null;
    }

    async getByYouTubeId(youtubeId: string): Promise<CachedMusicTrack | null> {
        const key = this.generateIdCacheKey(youtubeId, 'Youtube');
        const cached = await this.redisClient.get(key);
        return cached ? JSON.parse(cached) : null;
    }

    // Batch operations for multiple songs
    async batchSearch(queries: Array<{query: string, source?: string}>): Promise<Array<CachedMusicTrack | null>> {
        const promises = queries.map(({query, source}) => this.searchCache(query, source));
        return Promise.all(promises);
    }

    async batchCache(songs: Array<{song: MusicTrack, searchQuery: string}>): Promise<void> {
        const promises = songs.map(({song, searchQuery}) => this.cacheSong(song, searchQuery));
        await Promise.all(promises);
    }

    // Cache management and statistics
    private async updateHitStats(song: CachedMusicTrack, responseTime: number): Promise<void> {
        try {
            
            await Promise.all([
                this.updateCacheStats('cache_hits', 1),
                this.updateCacheStats('total_response_time', responseTime),
                this.redisClient.incr(`${this.STATS_PREFIX}song_hits:${song.id}`)
            ]);
            
            console.log(`[MusicCache] ✅ Cache HIT: "${song.title}" (${responseTime}ms)`);
        } catch (error) {
            console.error('[MusicCache] Error updating hit stats:', error);
        }
    }

    private async updateCacheStats(metric: string, value: number): Promise<void> {
        try {
            await this.redisClient.incrBy(`${this.STATS_PREFIX}${metric}`, value);
        } catch (error) {
            console.error(`[MusicCache] Error updating stat ${metric}:`, error);
        }
    }

    // Get comprehensive cache statistics
    async getStats(): Promise<any> {
        try {
            const [hits, misses, songsCached, totalResponseTime] = await Promise.all([
                this.redisClient.get(`${this.STATS_PREFIX}cache_hits`),
                this.redisClient.get(`${this.STATS_PREFIX}cache_misses`),
                this.redisClient.get(`${this.STATS_PREFIX}songs_cached`),
                this.redisClient.get(`${this.STATS_PREFIX}total_response_time`)
            ]);

            const numHits = parseInt(hits || '0');
            const numMisses = parseInt(misses || '0');
            const numSongsCached = parseInt(songsCached || '0');
            const totalTime = parseInt(totalResponseTime || '0');

            const totalRequests = numHits + numMisses;
            const hitRate = totalRequests > 0 ? (numHits / totalRequests) * 100 : 0;
            const avgResponseTime = numHits > 0 ? totalTime / numHits : 0;

            return {
                cache_hits: numHits,
                cache_misses: numMisses,
                hit_rate: `${hitRate.toFixed(2)}%`,
                songs_cached: numSongsCached,
                avg_response_time: `${avgResponseTime.toFixed(2)}ms`,
                total_requests: totalRequests
            };
        } catch (error) {
            console.error('[MusicCache] Error getting stats:', error);
            return {
                cache_hits: 0,
                cache_misses: 0,
                hit_rate: '0%',
                songs_cached: 0,
                avg_response_time: '0ms',
                total_requests: 0
            };
        }
    }

    // Cache maintenance
    async cleanupExpiredEntries(): Promise<void> {
        console.log('[MusicCache] Starting cleanup of expired entries...');
        // This would be implemented based on your specific needs
        // Redis handles TTL automatically, but you might want to clean up indexes
    }

    // Clear all cache (use with caution)
    async clearAllCache(): Promise<void> {
        console.log('[MusicCache] ⚠️  Clearing entire music cache...');
        const keys = await this.redisClient.keys(`${this.CACHE_PREFIX}*`);
        if (keys.length > 0) {
            await this.redisClient.del(keys);
        }
        console.log(`[MusicCache] ✅ Cleared ${keys.length} cache entries`);
    }
}
