// Base44 SDK Replacement for Replit
// This adapter provides the same interface as the Base44 SDK but uses
// our Express backend which communicates with Supabase directly

class EntityProxy {
  constructor(entityName, apiRequest) {
    this.entityName = entityName;
    this.apiRequest = apiRequest;
  }

  async list(options = {}) {
    const params = new URLSearchParams();
    
    // Handle legacy format where a sort string is passed directly (e.g., '-published_date')
    if (typeof options === 'string') {
      const sortString = options;
      const ascending = !sortString.startsWith('-');
      const field = sortString.replace(/^-/, '');
      params.set('sort', JSON.stringify({ [field]: ascending ? 'asc' : 'desc' }));
    } else {
      // Handle object options format
      if (options.filter) params.set('filter', JSON.stringify(options.filter));
      if (options.sort) params.set('sort', JSON.stringify(options.sort));
      if (options.limit) params.set('limit', options.limit);
      if (options.offset) params.set('offset', options.offset);
      if (options.expand) params.set('expand', options.expand);
      // Support additional custom query parameters
      if (options.queryParams) {
        Object.entries(options.queryParams).forEach(([key, value]) => {
          params.set(key, value);
        });
      }
    }
    
    const queryString = params.toString();
    const url = `/api/entities/${this.entityName}${queryString ? `?${queryString}` : ''}`;
    const response = await this.apiRequest(url);
    return response;
  }

  // Fetch all records with automatic pagination to handle Supabase's 1000 row limit
  async listAll(options = {}) {
    const allRecords = [];
    let offset = 0;
    const batchSize = 1000;
    let hasMore = true;
    
    while (hasMore) {
      const batch = await this.list({ 
        ...options,
        limit: batchSize, 
        offset: offset 
      });
      
      if (batch && batch.length > 0) {
        allRecords.push(...batch);
        offset += batch.length;
        hasMore = batch.length === batchSize;
      } else {
        hasMore = false;
      }
    }
    
    return allRecords;
  }

  async get(id, options = {}) {
    const params = new URLSearchParams();
    if (options.expand) params.set('expand', options.expand);
    
    const queryString = params.toString();
    const url = `/api/entities/${this.entityName}/${id}${queryString ? `?${queryString}` : ''}`;
    const response = await this.apiRequest(url);
    return response;
  }

  async create(data) {
    const response = await this.apiRequest(`/api/entities/${this.entityName}`, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' }
    });
    return response;
  }

  async update(id, data) {
    const response = await this.apiRequest(`/api/entities/${this.entityName}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' }
    });
    return response;
  }

  async delete(id) {
    const response = await this.apiRequest(`/api/entities/${this.entityName}/${id}`, {
      method: 'DELETE'
    });
    return response;
  }

  async filter(filterObj) {
    return this.list({ filter: filterObj });
  }
}

class FunctionsProxy {
  constructor(apiRequest) {
    this.apiRequest = apiRequest;
  }

  async invoke(functionName, params = {}) {
    const response = await this.apiRequest(`/api/functions/${functionName}`, {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' }
    });
    return { data: response };
  }
}

class AuthProxy {
  constructor(apiRequest) {
    this.apiRequest = apiRequest;
    this._currentUser = null;
    this._listeners = [];
  }

  async me() {
    try {
      const response = await this.apiRequest('/api/auth/me');
      this._currentUser = response;
      return response;
    } catch (error) {
      this._currentUser = null;
      return null;
    }
  }

  async isLoggedIn() {
    try {
      const user = await this.me();
      return !!user;
    } catch {
      return false;
    }
  }

  async logout() {
    await this.apiRequest('/api/auth/logout', { method: 'POST' });
    this._currentUser = null;
    this._notifyListeners(null);
  }

  onAuthStateChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notifyListeners(user) {
    this._listeners.forEach(callback => callback(user));
  }
}

class EntitiesProxy {
  constructor(apiRequest) {
    this.apiRequest = apiRequest;
    this._cache = {};
  }

  _getEntity(name) {
    if (!this._cache[name]) {
      this._cache[name] = new EntityProxy(name, this.apiRequest);
    }
    return this._cache[name];
  }

  // Define all entity accessors
  get Member() { return this._getEntity('Member'); }
  get Organization() { return this._getEntity('Organization'); }
  get Event() { return this._getEntity('Event'); }
  get Booking() { return this._getEntity('Booking'); }
  get ProgramTicketTransaction() { return this._getEntity('ProgramTicketTransaction'); }
  get MagicLink() { return this._getEntity('MagicLink'); }
  get OrganizationContact() { return this._getEntity('OrganizationContact'); }
  get Program() { return this._getEntity('Program'); }
  get Voucher() { return this._getEntity('Voucher'); }
  get XeroToken() { return this._getEntity('XeroToken'); }
  get BlogPost() { return this._getEntity('BlogPost'); }
  get Role() { return this._getEntity('Role'); }
  get TeamMember() { return this._getEntity('TeamMember'); }
  get DiscountCode() { return this._getEntity('DiscountCode'); }
  get DiscountCodeUsage() { return this._getEntity('DiscountCodeUsage'); }
  get SystemSettings() { return this._getEntity('SystemSettings'); }
  get TourGroup() { return this._getEntity('TourGroup'); }
  get TourStep() { return this._getEntity('TourStep'); }
  get Resource() { return this._getEntity('Resource'); }
  get ResourceCategory() { return this._getEntity('ResourceCategory'); }
  get FileRepository() { return this._getEntity('FileRepository'); }
  get ResourceAuthorSettings() { return this._getEntity('ResourceAuthorSettings'); }
  get JobPosting() { return this._getEntity('JobPosting'); }
  get PageBanner() { return this._getEntity('PageBanner'); }
  get IEditPage() { return this._getEntity('IEditPage'); }
  get IEditPageElement() { return this._getEntity('IEditPageElement'); }
  get IEditElementTemplate() { return this._getEntity('IEditElementTemplate'); }
  get ResourceFolder() { return this._getEntity('ResourceFolder'); }
  get FileRepositoryFolder() { return this._getEntity('FileRepositoryFolder'); }
  get NavigationItem() { return this._getEntity('NavigationItem'); }
  get ArticleCategory() { return this._getEntity('ArticleCategory'); }
  get ArticleComment() { return this._getEntity('ArticleComment'); }
  get CommentReaction() { return this._getEntity('CommentReaction'); }
  get ArticleReaction() { return this._getEntity('ArticleReaction'); }
  get ArticleView() { return this._getEntity('ArticleView'); }
  get ButtonStyle() { return this._getEntity('ButtonStyle'); }
  get Award() { return this._getEntity('Award'); }
  get OfflineAward() { return this._getEntity('OfflineAward'); }
  get OfflineAwardAssignment() { return this._getEntity('OfflineAwardAssignment'); }
  get EngagementAward() { return this._getEntity('EngagementAward'); }
  get EngagementAwardAssignment() { return this._getEntity('EngagementAwardAssignment'); }
  get OrganisationAward() { return this._getEntity('OrganisationAward'); }
  get OrganisationAwardAssignment() { return this._getEntity('OrganisationAwardAssignment'); }
  get WallOfFameSection() { return this._getEntity('WallOfFameSection'); }
  get WallOfFameCategory() { return this._getEntity('WallOfFameCategory'); }
  get WallOfFamePerson() { return this._getEntity('WallOfFamePerson'); }
  get Floater() { return this._getEntity('Floater'); }
  get Form() { return this._getEntity('Form'); }
  get FormSubmission() { return this._getEntity('FormSubmission'); }
  get NewsPost() { return this._getEntity('NewsPost'); }
  get SupportTicket() { return this._getEntity('SupportTicket'); }
  get SupportTicketResponse() { return this._getEntity('SupportTicketResponse'); }
  get PortalNavigationItem() { return this._getEntity('PortalNavigationItem'); }
  get MemberGroup() { return this._getEntity('MemberGroup'); }
  get MemberGroupAssignment() { return this._getEntity('MemberGroupAssignment'); }
  get GuestWriter() { return this._getEntity('GuestWriter'); }
  get PortalMenu() { return this._getEntity('PortalMenu'); }
  get AwardClassification() { return this._getEntity('AwardClassification'); }
  get AwardSublevel() { return this._getEntity('AwardSublevel'); }
  get MemberGroupGuest() { return this._getEntity('MemberGroupGuest'); }
  get CommunicationCategory() { return this._getEntity('CommunicationCategory'); }
  get CommunicationCategoryRole() { return this._getEntity('CommunicationCategoryRole'); }
  get MemberCommunicationPreference() { return this._getEntity('MemberCommunicationPreference'); }
  get PreferenceField() { return this._getEntity('PreferenceField'); }
  get MemberPreferenceValue() { return this._getEntity('MemberPreferenceValue'); }
  get OrganizationPreferenceValue() { return this._getEntity('OrganizationPreferenceValue'); }
  get Speaker() { return this._getEntity('Speaker'); }
  get TypographyStyle() { return this._getEntity('TypographyStyle'); }
  get CardDeck() { return this._getEntity('CardDeck'); }
  get DynamicDirectory() { return this._getEntity('DynamicDirectory'); }
  get TrainingFundTransaction() { return this._getEntity('TrainingFundTransaction'); }
  get VoucherTransaction() { return this._getEntity('VoucherTransaction'); }
  get Workflow() { return this._getEntity('Workflow'); }
  get WorkflowLog() { return this._getEntity('WorkflowLog'); }
  get EmailTemplate() { return this._getEntity('EmailTemplate'); }
  get MemberResourceCategory() { return this._getEntity('MemberResourceCategory'); }
  get RoleAccessItem() { return this._getEntity('RoleAccessItem'); }
  get RedirectMapping() { return this._getEntity('RedirectMapping'); }
  get ContractDocument() { return this._getEntity('ContractDocument'); }
  get ContractSigner() { return this._getEntity('ContractSigner'); }
  get ContractReminder() { return this._getEntity('ContractReminder'); }
  get FormDueDiligenceConfig() { return this._getEntity('FormDueDiligenceConfig'); }
  get FormSubmissionDueDiligence() { return this._getEntity('FormSubmissionDueDiligence'); }
  get EmailCampaign() { return this._getEntity('EmailCampaign'); }
  get EmailCampaignRecipient() { return this._getEntity('EmailCampaignRecipient'); }
  get EmailLinkClick() { return this._getEntity('EmailLinkClick'); }
  get EmailEvent() { return this._getEntity('EmailEvent'); }
  get EmailUnsubscribe() { return this._getEntity('EmailUnsubscribe'); }
}

const MAX_FILE_SIZE_PUBLIC = 10 * 1024 * 1024; // 10MB for public assets
const MAX_FILE_SIZE_PRIVATE = 25 * 1024 * 1024; // 25MB for private uploads
const MAX_FILE_SIZE = MAX_FILE_SIZE_PRIVATE; // Legacy compatibility

const UPLOAD_TYPES = {
  BRANDING: 'branding',
  PAGE: 'page',
  FORM_SUBMISSION: 'form-submission',
  ATTACHMENT: 'attachment',
  DOCUMENT: 'document',
  UPLOAD: 'upload'
};

function isPrivateUploadType(type) {
  return ['form-submission', 'attachment', 'document', 'private'].includes(type);
}

class CoreIntegration {
  constructor(apiRequest) {
    this.apiRequest = apiRequest;
  }

  async UploadFile({ file, onProgress, type = 'upload', entityId = null, isPrivate = null }) {
    if (!file) {
      throw new Error('No file provided');
    }
    
    const usePrivate = isPrivate !== null ? isPrivate : isPrivateUploadType(type);
    const maxSize = usePrivate ? MAX_FILE_SIZE_PRIVATE : MAX_FILE_SIZE_PUBLIC;
    
    if (file.size > maxSize) {
      const maxMB = maxSize / (1024 * 1024);
      throw new Error(`File size exceeds maximum allowed size of ${maxMB}MB. Your file is ${(file.size / (1024 * 1024)).toFixed(1)}MB.`);
    }
    
    const signedUrlResponse = await fetch('/api/storage/signed-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        type: type,
        entityId: entityId,
        isPrivate: usePrivate
      })
    });
    
    if (!signedUrlResponse.ok) {
      const errorData = await signedUrlResponse.json().catch(() => ({}));
      if (signedUrlResponse.status === 401) {
        throw new Error('You must be logged in to upload files');
      }
      throw new Error(errorData.error || 'Failed to get upload URL');
    }
    
    const { signedUrl, fileUrl, path: storagePath, bucket, isPrivate: resultPrivate } = await signedUrlResponse.json();
    
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          const percentComplete = Math.round((e.loaded / e.total) * 100);
          onProgress(percentComplete);
        }
      });
      
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });
      
      xhr.addEventListener('error', () => reject(new Error('Upload failed')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
      
      xhr.open('PUT', signedUrl);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.setRequestHeader('x-upsert', 'true');
      xhr.send(file);
    });
    
    return {
      file_url: fileUrl,
      storage_path: storagePath,
      bucket: bucket,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type,
      is_private: resultPrivate
    };
  }

  async UploadPrivateFile({ file, onProgress, type = 'document', entityId = null }) {
    return this.UploadFile({ file, onProgress, type, entityId, isPrivate: true });
  }

  async UploadFormSubmissionFile({ file, onProgress, formId = null }) {
    return this.UploadFile({ file, onProgress, type: UPLOAD_TYPES.FORM_SUBMISSION, entityId: formId, isPrivate: true });
  }

  async UploadBrandingAsset({ file, onProgress }) {
    return this.UploadFile({ file, onProgress, type: UPLOAD_TYPES.BRANDING, isPrivate: false });
  }

  async UploadPageAsset({ file, onProgress, pageId = null }) {
    return this.UploadFile({ file, onProgress, type: UPLOAD_TYPES.PAGE, entityId: pageId, isPrivate: false });
  }

  async GetSecureFileUrl({ storagePath, bucket = 'private-uploads', download = false }) {
    const params = new URLSearchParams({
      bucket,
      path: storagePath,
      ...(download && { download: 'true' })
    });

    const response = await fetch(`/api/storage/secure-url?${params}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        throw new Error('You must be logged in to access this file');
      }
      if (response.status === 403) {
        throw new Error('You do not have permission to access this file');
      }
      throw new Error(errorData.error || 'Failed to get file URL');
    }

    const { signedUrl } = await response.json();
    return signedUrl;
  }

  async CreateFileSignedUrl({ file_url }) {
    if (file_url && file_url.startsWith('/api/storage/secure-url')) {
      const urlObj = new URL(file_url, window.location.origin);
      const bucket = urlObj.searchParams.get('bucket');
      const storagePath = urlObj.searchParams.get('path');
      return { signedUrl: await this.GetSecureFileUrl({ storagePath, bucket }) };
    }
    return this.apiRequest('/api/integrations/create-signed-url', {
      method: 'POST',
      body: JSON.stringify({ file_url }),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async InvokeLLM(params) {
    return this.apiRequest('/api/integrations/invoke-llm', {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async SendEmail(params) {
    return this.apiRequest('/api/integrations/send-email', {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async GenerateImage(params) {
    return this.apiRequest('/api/integrations/generate-image', {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async ExtractDataFromUploadedFile(params) {
    return this.apiRequest('/api/integrations/extract-data', {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

class IntegrationsProxy {
  constructor(apiRequest) {
    this.Core = new CoreIntegration(apiRequest);
  }
}

class Base44Client {
  constructor(options = {}) {
    this.options = options;
    this._apiRequest = this._apiRequest.bind(this);
    this.entities = new EntitiesProxy(this._apiRequest);
    this.functions = new FunctionsProxy(this._apiRequest);
    this.auth = new AuthProxy(this._apiRequest);
    this.integrations = new IntegrationsProxy(this._apiRequest);
  }

  async _apiRequest(url, options = {}) {
    try {
      const response = await fetch(url, {
        ...options,
        credentials: 'include',
        headers: {
          ...options.headers,
        }
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.message || errorJson.error || response.statusText;
        } catch {
          errorMessage = errorBody || response.statusText;
        }
        throw new Error(`API Error (${response.status}): ${errorMessage}`);
      }

      return response.json();
    } catch (error) {
      if (error.message && error.message.startsWith('API Error')) {
        throw error;
      }
      throw new Error(`Network Error: ${error.message || 'Failed to fetch'}`);
    }
  }
}

export const base44 = new Base44Client({
  appId: "iconnect-agcas",
  requiresAuth: false
});

// For compatibility with existing code that imports createClient
export function createClient(options) {
  return new Base44Client(options);
}
